#!/usr/bin/env node
/**
 * 交互式会话（P0-2/3）的**真进程**集成验证。
 *
 * 三条必须真跑的断言，而不是"接口通了"：
 * 1. 工具循环：模型给一个工具块 → 平台真的去读了那个文件 → 下一轮请求里带上
 *    读到的内容 → 模型据此给最终答复。少了第二步，就退化成"模型假装读过了"。
 * 2. 补丁真落盘：apply_patch 只动上下文指向的那一行，未提及的行原样保留。
 * 3. 审批真的拦 && 拒绝理由真的回灌：第一次问人就拒（带理由），第二轮请求里
 *    必须出现那句理由；答"本会话不再问"之后，同一个工具第二次不再打扰。
 *
 * 口径说明：LLM 端点用**本进程起的假 HTTP 端点**（零配额、零网络），所以验的是
 * 平台行为而不是模型质量 —— 与 `scripts/offline-e2e-it.mjs` 同一立场。
 * 工具执行层、沙箱判定、TS 编译产物（dist-electron）全部是真的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-electron");

if (!fs.existsSync(path.join(dist, "electron", "chat", "session.js"))) {
  console.log(`FAIL: 找不到 chat 会话的编译产物（先 npm run build && npm run build:headless）：${dist}`);
  process.exit(1);
}

const { ChatSession } = await import(pathToFileURL(path.join(dist, "electron/chat/session.js")));
const { ToolRunner } = await import(pathToFileURL(path.join(dist, "electron/chat/tool-runner.js")));
const { OpenAiCompatibleClient } = await import(pathToFileURL(path.join(dist, "shared/http-clients.js")));



let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
    failures += 1;
  }
}

/** 按「字」切而不是按字节：中文被字节切开会变成乱码，看起来像模型说胡话。 */
function splitForStream(text, size) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out.length > 0 ? out : [""];
}

/**
 * 假大脑：按脚本依次应答，并把每轮收到的 messages 攒下来供断言。
 *
 * `sse: true` 时按请求里的 `stream` 字段决定要不要真发 SSE。
 *
 * ⚠️ 脚本**只在"这次应答会被用上"时才消耗**：客户端先发一次流式请求，端点不认
 * `stream` 时会再发一次整段请求（零增量退回）。假端点若在流式那一次也 shift，
 * 脚本就会整体错位一格 —— 表现是"第二轮没拿到工具结果""只问了一次审批"，
 * 看起来像平台坏了，其实是假的端点把脚本吃重了。所以流式尝试一律**偷看**不消耗。
 */
function startFakeBrain(replies, { sse = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const peek = replies[0];
      const isStreamAttempt = parsed.stream === true;
      if (sse && isStreamAttempt) {
        const mine = replies.shift();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const text = (mine?.message?.content ?? "(脚本用完)").toString();
        for (const piece of splitForStream(text, 6)) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 11 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // 端点不认 `stream`：形状是整段 JSON（客户端因此判零增量、退回重问），
      // 内容照给 —— 但**不消耗脚本**，重问那一次才该拿走这一份。
      const next = isStreamAttempt ? peek : replies.shift();
      if (!next) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "(脚本用完)" } }], model: "fake" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: next.message, finish_reason: "stop" }],
          model: "fake",
          usage: { total_tokens: 11 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function makeClient(port) {
  return new OpenAiCompatibleClient(
    {
      id: "fake",
      displayName: "fake",
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      defaultModel: "fake-1",
      apiKeyEnvVar: "",
    },
    "",
    undefined,
    5000,
  );
}

const TOOL_BLOCK = (o) => `先看一眼\n\`\`\`tool\n${JSON.stringify(o)}\n\`\`\``;

async function scenario_toolLoop() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-it-1-"));
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

  const brain = await startFakeBrain([
    // 第一轮：要它读文件
    {
      message: {
        content: TOOL_BLOCK({ tool: "read_file", arguments: { path: "src/a.ts" } }),
      },
    },
    // 第二轮：看到文件内容后打补丁
    {
      message: {
        content: TOOL_BLOCK({
          tool: "apply_patch",
          arguments: {
            patch: [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@ ",
              " const a = 1;",
              "-const b = 2;",
              "+const b = 3;",
              "*** End Patch",
            ].join("\n"),
          },
        }),
      },
    },
    // 第三轮：收束
    { message: { content: "b 已经改成 3，未提及的行原样保留。" } },
  ]);

  const client = new OpenAiCompatibleClient(
    {
      id: "fake",
      displayName: "fake",
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${brain.port}/v1`,
      defaultModel: "fake-1",
      apiKeyEnvVar: "",
    },
    "",
    undefined,
    5000,
  );
  const runner = new ToolRunner({ rootAbs: project, approvalPolicy: "on-request", approvalCommands: [] });
  const session = new ChatSession({ client, runner, rootAbs: project, toolProtocol: "text" });
  const t = await session.send("把 src/a.ts 的 b 改成 3");

  check("转录里有 user / tool_call / tool_result / assistant 四类条目", [
    "user",
    "tool_call",
    "tool_result",
    "assistant",
  ].every((k) => t.entries.some((e) => e.kind === k)), JSON.stringify(t.entries.map((e) => e.kind)));
  // 按内容找而不是按下标：端点不认 stream 时同一轮会有两次请求（先试流、后退
  // 整段），下标会漂；"工具结果有没有回到请求里"才是要钉的事实。
  check(
    "后续某一轮请求里带着 read_file 的真内容（不是模型假装读过）",
    brain.requests.some((r) => JSON.stringify(r.messages ?? []).includes("const a = 1;")),
    JSON.stringify(brain.requests.map((r) => ({ stream: r.stream, msgs: (r.messages ?? []).length }))),
  );
  check(
    "补丁真的落了盘，且只动那一行",
    fs.readFileSync(path.join(project, "src", "a.ts"), "utf8") === "const a = 1;\nconst b = 3;\n",
    fs.readFileSync(path.join(project, "src", "a.ts"), "utf8"),
  );
  check("最终答复进了转录", t.entries.at(-1)?.text.includes("b 已经改成 3"), String(t.entries.at(-1)?.text));

  brain.server.close();
  fs.rmSync(project, { recursive: true, force: true });
}

async function scenario_approval() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-it-2-"));
  const patch = [
    "*** Begin Patch",
    "*** Add File: guarded.txt",
    "+first",
    "*** End Patch",
  ].join("\n");
  const answers = [];
  /** 第一次问人那一刻盘上有没有那个文件 —— 只能当场采，之后会被第二次批准写到。 */
  let existedAtFirstAsk = null;
  let askCount = 0;

  const brain = await startFakeBrain([
    { message: { content: TOOL_BLOCK({ tool: "apply_patch", arguments: { patch } }) } },
    { message: { content: TOOL_BLOCK({ tool: "apply_patch", arguments: { patch: patch.replace("first", "second") } }) } },
    { message: { content: "两次都处理完了。" } },
  ]);
  const client = new OpenAiCompatibleClient(
    {
      id: "fake",
      displayName: "fake",
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${brain.port}/v1`,
      defaultModel: "fake-1",
      apiKeyEnvVar: "",
    },
    "",
    undefined,
    5000,
  );
  const runner = new ToolRunner({
    rootAbs: project,
    approvalPolicy: "untrusted",
    requestApproval: async (req) => {
      askCount += 1;
      answers.push(req.tool);
      if (askCount === 1) existedAtFirstAsk = fs.existsSync(path.join(project, "guarded.txt"));
      // 第一次拒（带理由），第二次准（本会话不再问）。
      return askCount === 1 ? { granted: false, reason: "别新建这个文件" } : { granted: true, scope: "session" };
    },
  });
  const t = await session_make(client, runner, project).send("新建 guarded.txt");

  check("第一次被拒 ⇒ 问人的那一刻盘上还没有那个文件", existedAtFirstAsk === false, JSON.stringify(existedAtFirstAsk));
  check(
    "拒绝理由回灌进了后续的请求（否则模型只会原样重试同一个动作）",
    brain.requests.some((r) => JSON.stringify(r.messages ?? []).includes("别新建这个文件")),
  );
  check("第二次批准 ⇒ 文件落了盘", fs.existsSync(path.join(project, "guarded.txt")));
  check("答过『本会话不再问』之后没有再打扰人", answers.length === 2, `实际问了 ${answers.length} 次`);
  check("转录里能看到审批结论", t.entries.some((e) => e.kind === "tool_result" && /别新建这个文件/.test(e.text)));

  brain.server.close();
  fs.rmSync(project, { recursive: true, force: true });
}

function session_make(client, runner, project) {
  return new ChatSession({ client, runner, rootAbs: project, toolProtocol: "text" });
}

async function scenario_sandbox() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-it-3-"));
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"x"}\n', "utf8");
  const brain = await startFakeBrain([
    {
      message: {
        content: TOOL_BLOCK({
          tool: "apply_patch",
          arguments: {
            patch: "*** Begin Patch\n*** Update File: package.json\n-{\"name\":\"x\"}\n+{\"name\":\"y\"}\n*** End Patch",
          },
        }),
      },
    },
    { message: { content: "改不了就换别的文件。" } },
  ]);
  const client = new OpenAiCompatibleClient(
    {
      id: "fake",
      displayName: "fake",
      protocol: "openai-compatible",
      baseUrl: `http://127.0.0.1:${brain.port}/v1`,
      defaultModel: "fake-1",
      apiKeyEnvVar: "",
    },
    "",
    undefined,
    5000,
  );
  const runner = new ToolRunner({ rootAbs: project, mode: "read-only" });
  const t = await session_make(client, runner, project).send("改 package.json 的名字");

  check(
    "read-only 档位下，受保护路径与写操作都会被拒，且理由说破",
    t.entries.some((e) => e.kind === "tool_result" && /read-only|package\.json/.test(e.text)),
    JSON.stringify(t.entries.filter((e) => e.kind === "tool_result").map((e) => e.text)),
  );
  check(
    "盘上没被动过",
    fs.readFileSync(path.join(project, "package.json"), "utf8") === '{"name":"x"}\n',
  );

  brain.server.close();
  fs.rmSync(project, { recursive: true, force: true });
}

/**
 * 流式（P1-1）在**真进程真 HTTP**里的两条断言：
 *   1. 端点真流时：一次请求拿到全文 + 多条增量（不是攒完一次性给）；
 *   2. 端点不认 stream 时：零增量退回整段 —— 两次请求，正文照样正确。
 * 这两条合起来才叫"能力不绑在端点声明上"。
 */
async function scenario_streaming() {
  const reply = "流式答复：一块一块地到，最后才收束。";

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-it-4-"));
  const brain = await startFakeBrain([{ message: { content: reply } }], { sse: true });
  const events = [];
  const session = new ChatSession({
    client: makeClient(brain.port),
    runner: new ToolRunner({ rootAbs: project }),
    rootAbs: project,
    toolProtocol: "text",
    onEvent: (e) => events.push(e),
  });
  const t = await session.send("说一句话");
  const deltas = events.filter((e) => e.type === "chat:delta").map((e) => e.text);

  check("真流式：一次 HTTP 请求就拿到全文（没有退回整段）", brain.requests.length === 1, `实际 ${brain.requests.length} 次`);
  check("增量是多条（逐块到达，不是攒完一次性给）", deltas.length > 1, `实际 ${deltas.length} 条`);
  check("增量拼起来就是最终正文", deltas.join("") === reply, JSON.stringify(deltas.join("")));
  check(
    "预览不重复进转录：assistant 条目只有一条",
    t.entries.filter((e) => e.kind === "assistant").length === 1,
    String(t.entries.filter((e) => e.kind === "assistant").length),
  );
  check("最终转录里就是这段正文", t.entries.at(-1)?.text === reply, String(t.entries.at(-1)?.text));
  brain.server.close();
  fs.rmSync(project, { recursive: true, force: true });

  // 同一个端点、不开 SSE：走"零增量退回"那条路。
  const project2 = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-it-4b-"));
  const brain2 = await startFakeBrain([{ message: { content: reply } }]);
  const events2 = [];
  const session2 = new ChatSession({
    client: makeClient(brain2.port),
    runner: new ToolRunner({ rootAbs: project2 }),
    rootAbs: project2,
    toolProtocol: "text",
    onEvent: (e) => events2.push(e),
  });
  const t2 = await session2.send("说一句话");
  check(
    "端点不认 stream：退回整段（两次请求：先试流、后退整段）",
    brain2.requests.length === 2 && brain2.requests[0].stream === true && brain2.requests[1].stream === undefined,
    JSON.stringify(brain2.requests.map((r) => r.stream)),
  );
  check("退回时一个增量都不发（半句字不能从预览里冒出来）", events2.filter((e) => e.type === "chat:delta").length === 0);
  check("退回后正文照样正确", t2.entries.at(-1)?.text === reply, String(t2.entries.at(-1)?.text));
  brain2.server.close();
  fs.rmSync(project2, { recursive: true, force: true });
}

console.log("chat-agent IT：");
await scenario_toolLoop();
await scenario_approval();
await scenario_sandbox();
await scenario_streaming();

if (failures > 0) {
  console.log(`FAIL: chat-agent IT ${failures} 项断言没过`);
  process.exit(1);
}
console.log(
  "PASS: chat-agent IT —— 工具循环真跑、补丁真落盘、审批真拦且理由回灌、read-only 真拒、流式真增量且零增量能退回",
);
