/**
 * 工具调用的**文本协议**（给不支持原生 function calling 的端点用）。
 *
 * 为什么要有第二条路：本项目默认线路是商汤那条 OpenAI 兼容端点，它是否接受
 * `tools` 字段**没有实测结论**（`scripts/probe-endpoints.cjs` 可探，但探测属于
 * 花钱动作、不进门禁）。如果工具能力只在"端点恰好支持"时才存在，那这条
 * P0 能力对默认用户就是不可用的 —— 所以能力本身必须由**平台**保证：
 *
 * - `native`：端点支持 `tools`，平台把 `TOOL_SPECS` 原样透传（见 http-clients）；
 * - `text`：端点不支持或未知，平台把工具表写进 system 提示、从模型输出里
 *   解析本模块定义的块。模型侧看到的是一段结构化文本，平台侧得到的结构
 *   与 `native` 完全一致（`ToolCall`）——**下游只认一种结构**，这是这一层存在的
 *   全部理由。
 *
 * 选择哪种由 `shared/providers.ts` 的 `ProviderConfig.tools` 决定，缺省 `text`
 * （保守：不把未验证的字段发给端点，避免整条线路 400）。
 */
import {
  MAX_TOOL_CALLS_PER_TURN,
  TOOL_SPECS,
  isToolName,
  validateToolArgs,
  type DynamicToolSpec,
  type ToolCall,
  type ToolResult,
  type ToolSpecLike,
} from "./spec";
import { validateMcpArgs } from "../mcp";

/** 文本协议里的围栏语言标记。 */
export const TOOL_FENCE = "tool";

export interface ParsedTurn {
  /** 工具块之外的正文（模型的说明/阶段小结），可能是空串。 */
  text: string;
  calls: ToolCall[];
  /** 解析中丢掉的块（形状不对 / 名字未登记）——必须回灌给模型，不能静默丢弃。 */
  problems: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取出文本里所有被 ```tool …``` 或 `<tool_call>…</tool_call>` 包住的内容。 */
export function extractToolBlocks(text: string): string[] {
  const out: string[] = [];
  // 围栏从 TOOL_FENCE 派生：标签串在一个地方登记，改名字不会只改成一半
  // （一半改成 prose 里的 <tool_call>，另一半还按旧围栏解析 —— 那种漂移
  //  表现为"模型明明给了调用，平台说没给"，最难归因）。
  const fenceRe = new RegExp("```" + TOOL_FENCE + "\\s*\\n?([\\s\\S]*?)\\n?```", "g");
  for (let m = fenceRe.exec(text); m !== null; m = fenceRe.exec(text)) out.push(m[1]);
  const tagRe = new RegExp("<" + TOOL_FENCE + "_call>([\\s\\S]*?)</" + TOOL_FENCE + "_call>", "g");
  for (let m = tagRe.exec(text); m !== null; m = tagRe.exec(text)) out.push(m[1]);
  return out;
}

/**
 * 解析一次模型输出。
 *
 * 一个块里允许 **一个**调用（`{"tool":…,"arguments":…}`）或**一个数组**
 * （模型想一次调多个工具时用）。数组形式按 `MAX_TOOL_CALLS_PER_TURN` 截断 ——
 * 一轮塞几十个工具调用没人审得过来，而且失败会连成一串难读的噪声。
 */
export function parseToolTurn(text: string, opts: { extraSpecs?: readonly DynamicToolSpec[] } = {}): ParsedTurn {
  const extra = opts.extraSpecs ?? [];
  const blocks = extractToolBlocks(text);
  const calls: ToolCall[] = [];
  const problems: string[] = [];
  let seq = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      problems.push(`工具块不是合法 JSON（已跳过）：${trimmed.slice(0, 120)}`);
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length > MAX_TOOL_CALLS_PER_TURN) {
      problems.push(`一轮最多 ${MAX_TOOL_CALLS_PER_TURN} 个工具调用，本次给了 ${list.length} 个，只执行前 ${MAX_TOOL_CALLS_PER_TURN} 个`);
    }
    for (const raw of list.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
      if (!isPlainObject(raw)) {
        problems.push(`工具调用不是对象（已跳过）：${JSON.stringify(raw).slice(0, 120)}`);
        continue;
      }
      const name = raw.tool ?? raw.name;
      const args = raw.arguments ?? raw.args ?? {};
      let invalid: string | null = null;
      if (isToolName(name)) {
        invalid = validateToolArgs(name, args);
      } else {
        const dynamic = typeof name === "string" ? extra.find((s) => s.name === name) : undefined;
        if (dynamic === undefined) {
          problems.push(`未登记的工具名（已跳过）：${String(name)}`);
          continue;
        }
        invalid = validateMcpArgs(name as string, dynamic.parameters, args);
      }
      if (invalid) {
        problems.push(`${invalid}（该调用已跳过）`);
        continue;
      }
      seq += 1;
      calls.push({ id: `t-${seq}`, name: name as string, args: args as Record<string, unknown> });
    }
  }
  const stripped = text
    .replace(/```tool\s*\n?[\s\S]*?\n?```/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
  return { text: stripped, calls, problems };
}

/**
 * 文本协议下注入 system 的工具说明。
 *
 * 只登记调用方真正开放的工具（`names`），并且把"一次只能给一个块、块外可以
 * 说话"写进规则 —— 不说清输出形状的模型会把 JSON 混进散文里，解析就会静默
 * 少执行一个工具，而"少执行"在会话里表现为"模型假装读过了"。
 */
export function toolCatalogBlock(names: readonly string[], specs: readonly ToolSpecLike[] = TOOL_SPECS): string {
  const usable = specs.filter((s) => names.includes(s.name));
  const lines: string[] = [
    "你可以使用以下工具。需要调用时，输出**且只输出**一个围栏块，块内是 JSON：",
    "",
    "```tool",
    '{"tool":"read_file","arguments":{"path":"src/index.ts"}}',
    "```",
    "",
    "规则：",
    "- 块外可以写简短说明；块内必须是一个合法 JSON 对象（或对象数组，最多 " + MAX_TOOL_CALLS_PER_TURN + " 个调用）。",
    "- 一轮只回答一次：要工具就给块，不要工具就直接给最终答复，不要同时给两者。",
    "- 工具结果会以「工具结果」的形式回到对话里，再据此继续。",
    "- 参数必须严格符合下方声明，缺必填参数会被跳过并把理由回灌给你。",
    "",
    "工具清单：",
  ];
  for (const spec of usable) {
    // MCP 的 inputSchema 是任意 JSON Schema 子集：字段名固定（required/properties），
    // 但每个属性的 type/description 可能是数组或缺席。这里只做展示级读取，
    // 校验由 `validateMcpArgs` 负责 —— 两处不共用一份"猜测"。
    const parameters = spec.parameters as { required?: unknown; properties?: unknown };
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((r): r is string => typeof r === "string")
      : [];
    const propsObj =
      typeof parameters.properties === "object" && parameters.properties !== null && !Array.isArray(parameters.properties)
        ? (parameters.properties as Record<string, unknown>)
        : {};
    const props = Object.entries(propsObj)
      .map(([key, raw]) => {
        const prop = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        const type = typeof prop.type === "string" ? prop.type : Array.isArray(prop.type) ? prop.type.join("|") : "any";
        const desc = typeof prop.description === "string" ? prop.description : "（无说明）";
        return `${key}（${type}${required.includes(key) ? "，必填" : "，可选"}）：${desc}`;
      })
      .join("；");
    lines.push(`- ${spec.name}：${spec.description}`);
    lines.push(`  参数：${props === "" ? "（无参数）" : props}`);
  }
  return lines.join("\n");
}

/**
 * 把工具结果回灌成一条 user 消息（文本协议）。
 *
 * 带上 `id` 是为了让模型能把自己的多次调用对上号；失败时把 `reason` 原样给回
 * 去 —— 沙箱拒绝的理由（"命令不在白名单内"）本身就是模型下一轮改进行动的
 * 依据，改写成"工具失败"等于让它重试同一个错误动作。
 */
export function toolResultBlock(results: readonly ToolResult[], problems: readonly string[] = []): string {
  const parts: string[] = ["工具结果："];
  for (const r of results) {
    const head = r.ok ? `[${r.id}] ${r.name} 成功` : `[${r.id}] ${r.name} 失败：${r.reason ?? "未知原因"}`;
    parts.push(head);
    if (r.output.trim() !== "") parts.push(r.output);
  }
  for (const p of problems) parts.push(`解析问题：${p}`);
  return parts.join("\n");
}
