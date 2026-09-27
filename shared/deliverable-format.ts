/**
 * 桥接智能体的交付物格式：解析 + 输出指令生成（单一事实来源）。
 *
 * 为什么存在：2026-09-26 实弹演习 t1（CSV 解析器）四发超时的根因治理。
 * 旧格式要求模型把完整代码文件内容作为 JSON 字符串输出 —— 代码里的引号、
 * 反斜杠、换行全部要转义，而 CSV 解析器恰恰是"引号处理本身就是业务逻辑"
 * 的任务，转义层叠转义（代码里的 `\"` 进 JSON 要写成 `\\\"`），生成 token
 * 膨胀、模型反复挣扎在 JSON 语法上，单次生成本身逼近/超过桥的单次尝试
 * 时限（300s）。新格式（OXFILE 分隔符原文块）让模型**原样输出文件内容、
 * 无需任何转义**，JSON 格式保留为回退（模型偶尔无视格式指令时接得住）。
 *
 * 消费方：scripts/loomy-bridge.mjs（运行时 require 本文件的编译产物
 * dist-electron/shared/deliverable-format.js）。内置执行器不用这个格式
 * —— 它有自己的结构化通道 —— 但未来其它 http-bridge 桥可以复用。
 */

export interface DeliverableFile {
  path: string;
  content: string;
}

export interface Deliverable {
  files: DeliverableFile[];
  summary: string;
}

/**
 * 生成 prompt 里的"输出格式"指令段。与 parseFileBlocks 是一纸合约的两面：
 * 这里教的格式就是那里解析的格式，测试锁定两者不漂移。
 */
export function buildOutputRules(zone: string): string {
  return [
    `3. 输出格式（严格遵守，不要 markdown 围栏、不要解释文字）——对每个文件输出一个文件块：`,
    `===OXFILE <${zone} 内的相对路径>===`,
    `<文件完整内容，原样书写：无需任何转义、不要代码围栏、保持真实换行>`,
    `===OXEND===`,
    `全部文件块之后，最后一行输出总结：`,
    `===OXSUMMARY=== <一句话总结>`,
    `注意：文件内容中禁止出现以 ===OX 开头的行；每个文件必须有自己的文件块，多文件就写多个块。`,
  ].join("\n");
}

const FILE_RE = /^===OXFILE\s+(.+?)(?:\s*===)?\s*$/;
const END_RE = /^===OXEND===\s*$/;
const SUMMARY_RE = /^===OXSUMMARY===(?:[ \t]+(.*))?$/;

/**
 * 解析 OXFILE 分隔符原文块。行尾统一归一为 LF（代码文件对 CRLF/LF 不敏感，
 * 归一换来解析的简单与可测）。设计取舍：
 * - 无任何块 → 返回空 files（不抛）：上层 parseDeliverable 决定回退 JSON；
 * - 块未闭合 → 抛错：截断的半份代码不如明确失败，让平台修复轮拿到根因；
 * - 空内容块 → 抛错：同上，模型挣扎的残迹要显式暴露；
 * - 未知的 ===OXTAG 之类行 → 当普通内容：只有三个精确控制词有效，防误伤正文。
 */
export function parseFileBlocks(text: string): Deliverable {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const files: DeliverableFile[] = [];
  let summary = "";
  let cur: { path: string; content: string[] } | null = null;

  for (const line of lines) {
    const fileMatch: RegExpMatchArray | null = cur === null ? line.match(FILE_RE) : null;
    if (fileMatch) {
      cur = { path: fileMatch[1], content: [] };
      continue;
    }
    if (cur !== null && END_RE.test(line)) {
      const content = cur.content.join("\n");
      if (content.trim() === "") {
        throw new Error(`交付解析失败：文件块 ${cur.path} 空内容（模型未产出任何文件正文）`);
      }
      files.push({ path: cur.path, content });
      cur = null;
      continue;
    }
    const summaryMatch = line.match(SUMMARY_RE);
    if (summaryMatch && cur === null) {
      summary = (summaryMatch[1] ?? "").trim();
      continue;
    }
    if (cur !== null) cur.content.push(line);
  }

  if (cur !== null) {
    throw new Error(
      `交付解析失败：文件块 ${cur.path} 未闭合（缺少 ===OXEND===，疑似输出被截断）`,
    );
  }
  return { files, summary };
}

/**
 * 交付总入口：先试分隔符原文块（新格式），失败或无块时回退旧 JSON 格式。
 * 两种都失败时抛出聚合错误，两个根因都带上，修复轮能看到完整事实。
 */
export function parseDeliverable(text: string): Deliverable {
  let blockErr: unknown = null;
  try {
    const out = parseFileBlocks(text);
    if (out.files.length > 0) return out;
  } catch (err) {
    blockErr = err;
  }

  try {
    const out = extractJson(text);
    if (Array.isArray(out.files) && out.files.length > 0) {
      return {
        files: out.files as DeliverableFile[],
        summary: typeof out.summary === "string" ? out.summary : "",
      };
    }
  } catch (jsonErr) {
    const blockMsg = blockErr instanceof Error ? blockErr.message : String(blockErr ?? "无文件块");
    throw new Error(
      `交付解析失败：OXFILE 块格式与 JSON 格式均无法解析 — 块格式：${blockMsg}；JSON 格式：${
        jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
      }`,
    );
  }

  const blockMsg = blockErr instanceof Error ? blockErr.message : String(blockErr ?? "无文件块");
  throw new Error(`交付解析失败：OXFILE 块格式与 JSON 格式均无法解析 — 块格式：${blockMsg}；JSON 格式：响应中无文件`);
}

/** 旧 JSON 交付格式的提取（从 loomy-bridge 迁出，作为回退路径）。 */
export function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("响应中没有 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}
