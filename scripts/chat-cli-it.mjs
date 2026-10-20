#!/usr/bin/env node
/**
 * `ox chat` 的**真进程**端到端验证（CLI 形态）。
 *
 * 断言的是行为而不是接口：
 *   · exec --json 真跑一次工具循环，工具结果真的回到下一轮请求；
 *   · 会话落盘后，第二个进程用 --session 继续时带着上一轮上下文；
 *   · 项目 policy.d 的 denyCommands 在 CLI 里也真的拦住命令；
 *   · 非交互 + untrusted 没有审批通道 ⇒ 写盘前就被拒绝（fail-closed）；
 *   · REPL 能启动并响应 /help。
 *
 * LLM 用本进程起的假 OpenAI 兼容端点（零配额、零网络），其余全部是真的：
 * 真 spawn CLI、真读写文件、真跑沙箱判定、真落盘会话。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "dist-headless", "headless", "chat-main.js");

if (!fs.existsSync(CLI)) {
  console.error(`FAIL: 找不到 ${CLI} —— 先跑 npm run build:headless`);
  process.exit(1);
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

const tool = (name, args) => `\`\`\`tool\n${JSON.stringify({ tool: name, arguments: args })}\n\`\`\``;

/** 按「字」切：按字节切中文会变乱码，看起来像模型说胡话。 */
function splitForStream(text, size) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out.length > 0 ? out : [""];
}

/**
 * 假大脑。`sse: true` 且请求带 `stream: true` 时发真 SSE；
 * 不开就是"端点忽略 stream"的形状（用来验零增量退回）。
 */
function startBrain({ sse = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // keep empty
      }
      requests.push(parsed);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      let content;
      if (lastUser.startsWith("工具结果：")) {
        if (lastUser.includes("const a = 1;")) content = "文件内容是 const a = 1;";
        else if (lastUser.includes("补丁已应用")) content = "改好了";
        else if (lastUser.includes("命令被沙箱禁止")) content = "命令被拒绝了";
        else if (lastUser.includes("需要人工确认")) content = "没有写";
        else content = "收到工具结果";
      } else if (lastUser.includes("读一下")) {
        content = tool("read_file", { path: "src/a.ts" });
      } else if (lastUser.includes("改文件")) {
        content = tool("apply_patch", {
          patch: ["*** Begin Patch", "*** Update File: src/a.ts", "@@ ", " const a = 1;", "-const b = 2;", "+const b = 3;", "*** End Patch"].join("\n"),
        });
      } else if (lastUser.includes("跑命令")) {
        content = tool("run_command", { command: "node", args: ["marker.js"] });
      } else if (lastUser.includes("继续")) {
        content = "第二轮完成";
      } else if (lastUser.includes("流式")) {
        // 够长才有"多块"这件事：短的回复只能证明"确实没报错"。
        content = "流式第一段；流式第二段；流式第三段。";
      } else {
        content = "好的";
      }
      if (sse && parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const piece of splitForStream(content, 6)) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 5 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
          model: "fake",
          usage: { total_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, port: server.address().port }),
    );
  });
}

function runCli(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function tempProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-chat-cli-${name}-`));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
  fs.writeFileSync(path.join(dir, "marker.js"), "require('node:fs').writeFileSync('ran.txt','yes');\n", "utf8");
  return dir;
}

function parseEvents(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const brain = await startBrain();
  const baseUrl = `http://127.0.0.1:${brain.port}/v1`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-cli-home-"));
  const env = {
    ...process.env,
    OX_HOME: home,
    SENSENOVA_API_KEY: "sk-fake-chat-cli",
    NO_COLOR: "1",
  };
  const common = ["--base-url", baseUrl, "--model", "fake", "--json", "--approval", "never"];
  const project = tempProject("main");
  try {
    console.log("exec --json：工具循环 + 工具结果回灌");
    const first = await runCli(["exec", "读一下 src/a.ts", "--cwd", project, ...common], env);
    const events = parseEvents(first.stdout);
    check("exit 0", first.code === 0, `exit=${first.code} stderr=${first.stderr.slice(0, 200)}`);
    check("有 tool_call read_file", events.some((e) => e.type === "chat:entry" && e.entry?.kind === "tool_call" && e.entry?.tool?.name === "read_file"));
    check("有最终答复", events.some((e) => e.type === "chat:entry" && e.entry?.kind === "assistant" && String(e.entry.text).includes("const a = 1")));
    check(
      "工具结果真的进了下一轮请求",
      brain.requests.some((r) => JSON.stringify(r.messages ?? []).includes("const a = 1;")),
    );

    console.log("会话落盘 + 第二个进程 --session 继续");
    const list = await runCli(["list", "--cwd", project], env);
    const ids = `${list.stdout}${list.stderr}`.match(/chat-[A-Za-z0-9-]+/g) ?? [];
    check("list 列出会话 id", list.code === 0 && ids.length >= 1, `${list.stdout.slice(0, 160)}`);
    const id = ids[0];
    const resumed = await runCli(["exec", "继续", "--session", id, "--cwd", project, ...common], env);
    check("resume exit 0", resumed.code === 0, `exit=${resumed.code} stderr=${resumed.stderr.slice(0, 200)}`);
    const resumeReq = brain.requests.at(-1);
    check(
      "resume 请求里带着上一轮的助手答复",
      JSON.stringify(resumeReq?.messages ?? []).includes("文件内容是 const a = 1;"),
    );

    console.log("policy.d：CLI 里 denyCommands 也生效");
    const policyProject = tempProject("policy");
    fs.mkdirSync(path.join(policyProject, ".ox", "policy.d"), { recursive: true });
    fs.writeFileSync(
      path.join(policyProject, ".ox", "policy.d", "deny.json"),
      JSON.stringify({ version: 1, denyCommands: ["node"] }),
      "utf8",
    );
    const denied = await runCli(["exec", "跑命令", "--cwd", policyProject, ...common], env);
    check("exit 0（工具失败被回灌，不是进程崩）", denied.code === 0, `exit=${denied.code}`);
    const deniedEvents = parseEvents(denied.stdout);
    check(
      "命令被沙箱拒绝且没有执行",
      deniedEvents.some((e) => e.type === "chat:entry" && e.entry?.kind === "tool_result" && String(e.entry.text).includes("命令被沙箱禁止")) &&
        !fs.existsSync(path.join(policyProject, "ran.txt")),
    );

    console.log("非交互 + untrusted：审批 fail-closed，写盘前拒绝");
    const guarded = tempProject("guarded");
    fs.mkdirSync(path.join(guarded, ".ox"), { recursive: true });
    fs.writeFileSync(
      path.join(guarded, ".ox", "config.json"),
      JSON.stringify({ version: 1, approvalPolicy: "untrusted" }),
      "utf8",
    );
    const guard = await runCli(["exec", "改文件", "--cwd", guarded, "--base-url", baseUrl, "--model", "fake", "--json"], env);
    check("exit 0（拒绝被回灌给模型）", guard.code === 0, `exit=${guard.code}`);
    check("文件没有被写", fs.readFileSync(path.join(guarded, "src", "a.ts"), "utf8") === "const a = 1;\nconst b = 2;\n");
    check(
      "转录里说破没有审批通道",
      parseEvents(guard.stdout).some((e) => e.type === "chat:entry" && e.entry?.kind === "tool_result" && String(e.entry.text).includes("没有审批通道")),
    );

    console.log("REPL：/help + /exit 能启动并干净退出");
    const repl = await runCli([], env, "/help\n/exit\n");
    check("REPL exit 0", repl.code === 0, `exit=${repl.code}`);
    check("REPL 打印帮助", `${repl.stdout}`.includes("ox chat - interactive coding agent"));

    console.log("流式：--json 里真的带 chat:delta（真进程真 HTTP）");
    const sseBrain = await startBrain({ sse: true });
    try {
      const sseRun = await runCli(
        [
          "exec",
          "流式地说一句",
          "--cwd",
          project,
          "--base-url",
          `http://127.0.0.1:${sseBrain.port}/v1`,
          "--model",
          "fake",
          "--json",
          "--approval",
          "never",
        ],
        env,
      );
      const sseEvents = parseEvents(sseRun.stdout);
      const deltas = sseEvents.filter((e) => e.type === "chat:delta").map((e) => String(e.text ?? ""));
      check("exit 0", sseRun.code === 0, `exit=${sseRun.code} stderr=${sseRun.stderr.slice(0, 200)}`);
      check("增量不止一条（逐块到达，不是攒完一次给）", deltas.length > 1, `实际 ${deltas.length} 条`);
      check(
        "增量拼起来就是最终正文",
        deltas.join("") === "流式第一段；流式第二段；流式第三段。",
        JSON.stringify(deltas.join("")),
      );
      check(
        "正文 entry 仍然只落一条（预览不重复进转录）",
        sseEvents.filter((e) => e.type === "chat:entry" && e.entry?.kind === "assistant").length === 1,
      );
    } finally {
      sseBrain.server.close();
    }
  } finally {
    brain.server.close();
    for (const dir of [project, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }

  console.log(failures === 0 ? "\nchat CLI IT 全部通过 ✅" : `\nchat CLI IT 失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
