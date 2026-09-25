import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllRoutesCoolingError } from "../shared/http-clients";
import { SensenovaApiAdapter, parseFilePayload } from "../electron/agents/sensenova-api";
import type { LlmClient } from "../shared/llm-client";
import type { ChatRequest, ChatResponse } from "../shared/llm-client";

function fakeClient(reply: string | Error): LlmClient {
  return {
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      if (reply instanceof Error) throw reply;
      return { content: reply, provider: "test", model: "test-model" };
    },
  };
}

function scriptedClient(replies: Array<string | Error>): { client: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const client: LlmClient = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      prompts.push(req.messages.map((m) => m.content).join("\n"));
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return { content: r, provider: "test", model: "test-model" };
    },
  };
  return { client, prompts };
}

/**
 * 每个 fixture 目录都要登记，`afterEach` 统一收。
 *
 * 这里此前**一个都不删** —— 实测本文件跑一轮留下一个 `ox-sensenova-*`，
 * 累积到 4822 个（含 node_modules/src/tests 骨架），是 `%TEMP%` 里最大的一堆。
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上子进程可能仍持有句柄；留给系统临时目录清理，不因此让用例失败
    }
  }
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sensenova-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { build: "keep", test: "keep" } }),
    "utf8",
  );
  return dir;
}

function run(adapter: SensenovaApiAdapter, root: string, description = "实现 src/add.js") {
  return adapter.dispatch({
    runId: `r-${Math.random().toString(36).slice(2)}`,
    taskId: "t1",
    title: "加法模块",
    description,
    zone: "z1",
    projectRoot: root,
  });
}

async function terminalText(adapter: SensenovaApiAdapter, handle: Awaited<ReturnType<typeof run>>) {
  let last = "";
  for await (const ev of adapter.collect(handle)) {
    if (ev.kind !== "log") last = `${ev.kind}: ${ev.text}`;
  }
  return last;
}

/**
 * `parseFilePayload` is the validator the live path actually runs
 * (`chatJson(..., { validate: parseFilePayload })`). The old `parseFiles`
 * helper — which did its own fence-stripping and indexOf/lastIndexOf
 * extraction — was deleted: it had no production caller, and the extraction it
 * duplicated is covered by llm-client.test.ts against `extractJsonCandidates`.
 */
describe("parseFilePayload", () => {
  it("keeps well-formed entries", () => {
    expect(parseFilePayload({ files: [{ path: "a.js", content: "x" }] })).toEqual([
      { path: "a.js", content: "x" },
    ]);
  });

  it("drops non-string-field entries and lets the caller fail on an empty result", () => {
    expect(parseFilePayload({ files: [{ path: 1, content: "x" }] })).toEqual([]);
  });

  it("rejects a payload that is not a files object — each clause is load-bearing", () => {
    // The guard is `typeof value !== "object" || value === null || !Array.isArray(files)`.
    // Flipping any `||` to `&&` demands all three failures at once, which is
    // impossible in practice — the protocol check then silently passes and the
    // adapter writes whatever the model returned.
    //
    // `null` is the sharpest case: `typeof null === "object"`, so only the
    // middle clause catches it. With `&&` it slips straight through.
    //
    // ⚠️ 断言必须匹配**我们抛的那句话**，不能只匹配 `/files/`：
    // 改 `&&` 之后 `null.files` 会抛 TypeError，而那条消息是
    // `Cannot read properties of null (reading 'files')` —— **里面也有 "files"**。
    // 用宽正则等于把这个变异放过去（实测：第一版写 `/files/` 时它存活）。
    const RE = /模型 JSON 缺少/;
    expect(() => parseFilePayload(null)).toThrowError(RE);
    expect(() => parseFilePayload("a string")).toThrowError(RE);
    expect(() => parseFilePayload({})).toThrowError(RE);
    expect(() => parseFilePayload({ files: "not-an-array" })).toThrowError(RE);
  });
});

describe("SensenovaApiAdapter", () => {
  /**
   * 取消的语义收口：模型这一回合**算完了**（token 已经花掉，这一条改不了），
   * 但往用户工作区落文件是不可逆副作用 —— 中止之后必须丢弃。
   * 假客户端停在 chat 里等我们放行，正好复现"在途请求返回时 run 已经不在了"。
   */
  it("drops the generated files when the run was aborted while the model was still answering", async () => {
    const root = tmpRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: LlmClient = {
      async chat(): Promise<ChatResponse> {
        await gate;
        return {
          content: JSON.stringify({ files: [{ path: "src/add.js", content: "module.exports = 1;" }] }),
          provider: "test",
          model: "test-model",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root);
    const pump = (async () => {
      for await (const _e of adapter.collect(handle)) {
        // 只是消费事件；断言看的是文件系统这个外部事实
      }
    })();
    await new Promise((r) => setTimeout(r, 0)); // 让 dispatch 走进 chat
    await adapter.abort(handle);
    release(); // 模型**这才有答案** —— 此时 run 已经中止
    await pump;
    /*
     * collect 在 abort 那一刻就收摊了（session.finished），"丢弃"那条 log 不经过这里，
     * 所以断言只看外部事实。60ms 远大于那一回合的收尾（writeFiles 是同步的），
     * 未修的实现此刻必然已经落盘。
     */
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.existsSync(path.join(root, "src", "add.js"))).toBe(false);
  });

  /**
   * 被沙箱拒掉的路径必须出现在**终态**里。只在中间日志流说一句「跳过」是不够的：
   * 重修循环带进 prompt 的是这份摘要，模型看到"写入 1 个文件"就以为都落了，
   * 下一轮原样再写一遍同一条被拒路径 —— 预算空烧，而且没人告诉它为什么红。
   */
  it("names sandbox-refused paths in the terminal event, not just in the log stream", async () => {
    const root = tmpRoot();
    const payload = JSON.stringify({
      files: [
        { path: "src/ok.js", content: "module.exports = 1;" },
        { path: ".git/config", content: "[core] nope" },
      ],
    });
    const adapter = new SensenovaApiAdapter(scriptedClient([payload]).client);
    const texts: string[] = [];
    const handle = await run(adapter, root);
    for await (const e of adapter.collect(handle)) texts.push(`${e.kind}:${e.text}`);
    const joined = texts.join(" | ");
    expect(joined).toContain("completed:写入 1 个文件");
    expect(joined).toContain("沙箱拒绝 1 个：.git/config");
    expect(fs.existsSync(path.join(root, "src", "ok.js"))).toBe(true);
  });

  it("全部被拒时，失败摘要点名被拒路径而不是含糊说「没返回文件」", async () => {
    const root = tmpRoot();
    const payload = JSON.stringify({ files: [{ path: ".git/config", content: "nope" }] });
    const adapter = new SensenovaApiAdapter(scriptedClient([payload]).client);
    const texts: string[] = [];
    const handle = await run(adapter, root);
    for await (const e of adapter.collect(handle)) texts.push(`${e.kind}:${e.text}`);
    const joined = texts.join(" | ");
    expect(joined).toContain("全部被沙箱拒绝");
    expect(joined).toContain(".git/config");
    // 模型确实返回了文件，说"未返回可写入的文件"会把归因带偏到模型输出格式上
    expect(joined).not.toContain("模型未返回可写入的文件");
  });

  it("writes model-returned files and completes", async () => {
    const root = tmpRoot();
    const adapter = new SensenovaApiAdapter(
      fakeClient('{"files":[{"path":"src/add.js","content":"module.exports.add=(a,b)=>a+b;"}]}'),
    );
    const handle = await run(adapter, root);
    const terminal = await terminalText(adapter, handle);
    expect(terminal.startsWith("completed")).toBe(true);
    const written = fs.readFileSync(path.join(root, "src", "add.js"), "utf8");
    expect(written).toContain("module.exports.add");
  });

  it("blocks protected paths (escape, package.json, ox-scripts, node_modules)", async () => {
    const root = tmpRoot();
    const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const adapter = new SensenovaApiAdapter(
      fakeClient(
        JSON.stringify({
          files: [
            { path: "../evil.js", content: "nope" },
            { path: "package.json", content: "{}" },
            { path: "ox-scripts/build.js", content: "nope" },
            { path: "node_modules/x/index.js", content: "nope" },
            { path: "src/ok.js", content: "// fine" },
          ],
        }),
      ),
    );
    const handle = await run(adapter, root);
    const terminal = await terminalText(adapter, handle);
    expect(terminal.startsWith("completed")).toBe(true);
    expect(fs.existsSync(path.join(root, "..", "evil.js"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "ox-scripts", "build.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "ok.js"))).toBe(true);
  });

  it("fails the run when the model errors or returns nothing writable", async () => {
    const root = tmpRoot();
    const errAdapter = new SensenovaApiAdapter(fakeClient(new Error("HTTP 429 all combos")));
    const h1 = await run(errAdapter, root);
    expect((await terminalText(errAdapter, h1)).startsWith("failed")).toBe(true);

    const emptyAdapter = new SensenovaApiAdapter(fakeClient('{"files":[]}'));
    const h2 = await run(emptyAdapter, root);
    expect((await terminalText(emptyAdapter, h2)).startsWith("failed")).toBe(true);
  });

  it("self-corrects non-protocol output (raw markdown) via retry", async () => {
    const root = tmpRoot();
    const rawDoc = "# 使用说明\n\n本项目用于演示。安装后运行 npm test 即可。";
    const good = '{"files":[{"path":"README.md","content":"# 使用说明"}]}';
    const { client, prompts } = scriptedClient([rawDoc, good]);
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root, "编写 README 文档");
    const terminal = await terminalText(adapter, handle);
    expect(terminal.startsWith("completed")).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("files-protocol");
    expect(prompts[1]).toContain("# 使用说明");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("# 使用说明");
  });

  it("fails after exhausting protocol self-correction retries", async () => {
    const root = tmpRoot();
    const stubborn = "# 文档\n内容";
    const { client, prompts } = scriptedClient([stubborn]);
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root, "编写文档");
    const all: string[] = [];
    for await (const ev of adapter.collect(handle)) all.push(`${ev.kind}: ${ev.text}`);
    expect(all.some((t) => t.includes("协议自纠偏失败"))).toBe(true);
    expect(all[all.length - 1].startsWith("failed")).toBe(true);
    expect(prompts).toHaveLength(3); // 1 initial + 2 retries
  });

  it("injects repair context into the prompt on repair rounds", async () => {
    const root = tmpRoot();
    let seenPrompt = "";
    const client: LlmClient = {
      async chat(req: ChatRequest) {
        seenPrompt = req.messages.map((m) => m.content).join("\n");
        return {
          content: '{"files":[{"path":"src/fix.js","content":"// ok"}]}',
          provider: "test",
          model: "m",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const root2 = tmpRoot();
    const handle = await adapter.dispatch({
      runId: "r-repair",
      taskId: "t9",
      title: "修复",
      description: "desc",
      zone: "z",
      projectRoot: root2,
      repairContext: { round: 2, errorLogDigest: "TypeError: boom at add()" },
    });
    await terminalText(adapter, handle);
    expect(seenPrompt).toContain("第 2 轮修复");
    expect(seenPrompt).toContain("TypeError: boom at add()");
    void root;
  });

  it("includes workspace snapshot in the prompt and skips protected dirs", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "src", "core.js"), "module.exports.core=1;", "utf8");
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "// dep", "utf8");
    let seenPrompt = "";
    const client: LlmClient = {
      async chat(req: ChatRequest) {
        seenPrompt = req.messages.map((m) => m.content).join("\n");
        return {
          content: '{"files":[{"path":"src/ok.js","content":"// fine"}]}',
          provider: "test",
          model: "m",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root);
    await terminalText(adapter, handle);
    expect(seenPrompt).toContain("当前工作区已有文件");
    expect(seenPrompt).toContain("=== src/core.js ===");
    expect(seenPrompt).toContain("module.exports.core=1;");
    expect(seenPrompt).not.toContain("// dep");
  });

  it("构建产物不得占满快照预算：真实源码必须进到 prompt 里", async () => {
    // 快照按**路径序**消耗 32k 总预算，而 `coverage/` 与 `dist/` 都排在 `src/` 前面 ——
    // 生成目录一旦被计进来，模型读到的就是整包 bundle，项目源码一个字节都进不去。
    // 本机实测（改前）：12 个进快照的文件里 11 个是产物，src/ 命中 0 / 5。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "src", "core.js"), "module.exports.real=1;", "utf8");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(root, "dist", `chunk-${i}.js`), "b".repeat(3000), "utf8");
    }
    fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
    fs.writeFileSync(path.join(root, "coverage", "lcov.info"), "SF:src/core.js\n".repeat(500), "utf8");
    let seenPrompt = "";
    const client: LlmClient = {
      async chat(req: ChatRequest) {
        seenPrompt = req.messages.map((m) => m.content).join("\n");
        return {
          content: '{"files":[{"path":"src/ok.js","content":"// fine"}]}',
          provider: "test",
          model: "m",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root);
    await terminalText(adapter, handle);
    expect(seenPrompt).toContain("=== src/core.js ===");
    expect(seenPrompt).not.toContain("=== dist/");
    expect(seenPrompt).not.toContain("=== coverage/");
  });

  it("truncates oversized files in the snapshot", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "src", "big.js"), "x".repeat(9000), "utf8");
    let seenPrompt = "";
    const client: LlmClient = {
      async chat(req: ChatRequest) {
        seenPrompt = req.messages.map((m) => m.content).join("\n");
        return {
          content: '{"files":[{"path":"src/ok.js","content":"// fine"}]}',
          provider: "test",
          model: "m",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root);
    await terminalText(adapter, handle);
    expect(seenPrompt).toContain("=== src/big.js ===");
    expect(seenPrompt).toContain("（截断）");
  });

  it("caches the snapshot by mtime fingerprint and re-reads only after changes", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "src", "core.js"), "module.exports.core=1;", "utf8");
    // Reply only touches a protected path → writeFiles skips it → run fails
    // without touching the workspace, so the fingerprint stays stable.
    const reply = JSON.stringify({ files: [{ path: "package.json", content: "{}" }] });
    const client: LlmClient = {
      async chat(): Promise<ChatResponse> {
        return { content: reply, provider: "test", model: "m" };
      },
    };
    const adapter = new SensenovaApiAdapter(client);
    const readSpy = vi.spyOn(fs, "readFileSync");

    await terminalText(adapter, await run(adapter, root)); // cache miss → contents read
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThanOrEqual(2); // package.json + src/core.js

    await terminalText(adapter, await run(adapter, root)); // fingerprint hit → no content reads
    expect(readSpy.mock.calls.length).toBe(readsAfterFirst);

    fs.writeFileSync(path.join(root, "src", "core.js"), "module.exports.core=2;", "utf8"); // invalidate
    await terminalText(adapter, await run(adapter, root)); // fingerprint changed → re-read
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    readSpy.mockRestore();
  });

  it("waits out an all-cooling spell and retries instead of failing the task", async () => {
    const root = tmpRoot();
    const good = '{"files":[{"path":"src/ok.js","content":"// fine"}]}';
    const { client, prompts } = scriptedClient([new AllRoutesCoolingError(20), good]);
    const adapter = new SensenovaApiAdapter(client);
    const handle = await run(adapter, root);
    const all: string[] = [];
    for await (const ev of adapter.collect(handle)) all.push(`${ev.kind}: ${ev.text}`);
    expect(all[all.length - 1].startsWith("completed")).toBe(true);
    expect(prompts).toHaveLength(2); // initial call + one retry after the cooldown wait
    expect(all.some((t) => t.includes("全部模型组合冷却中"))).toBe(true);
  });

  it("limits concurrent LLM calls to the configured semaphore size", async () => {
    const root = tmpRoot();
    let active = 0;
    let peak = 0;
    const client: LlmClient = {
      async chat(): Promise<ChatResponse> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        active--;
        return {
          content: '{"files":[{"path":"src/ok.js","content":"// fine"}]}',
          provider: "test",
          model: "test-model",
        };
      },
    };
    const adapter = new SensenovaApiAdapter(client, { maxConcurrent: 2 });
    const handles = await Promise.all([
      run(adapter, root),
      run(adapter, root),
      run(adapter, root),
    ]);
    const logs: string[] = [];
    for (const h of handles) {
      for await (const ev of adapter.collect(h)) {
        if (ev.kind === "log") logs.push(ev.text);
      }
    }
    expect(peak).toBe(2); // never more than 2 in flight despite 3 parallel tasks
    expect(logs.some((t) => t.includes("排队等待"))).toBe(true); // third task queued visibly
  });

  it("does not report queueing when a slot was free", async () => {
    // `acquireSlot()` returns false when it took a slot immediately. Flipping
    // that `return false` to `true` makes every run claim it had to queue —
    // an operator reading the log then blames a concurrency limit that never
    // actually bound. This is the negative half of the semaphore test above.
    const adapter = new SensenovaApiAdapter(
      fakeClient('{"files":[{"path":"src/ok.js","content":"// fine"}]}'),
      { maxConcurrent: 4 },
    );
    const handle = await run(adapter, tmpRoot());
    const logs: string[] = [];
    for await (const ev of adapter.collect(handle)) {
      if (ev.kind === "log") logs.push(ev.text);
    }
    expect(logs.some((t) => t.includes("排队等待"))).toBe(false);
  });

  it("aborts an unknown run id without crashing", async () => {
    // Same shape as the CLI adapter: `!session || session.finished` degrades
    // into a TypeError on `session` when written with `&&`.
    const adapter = new SensenovaApiAdapter(fakeClient('{"files":[]}'));
    await expect(
      adapter.abort({ runId: "ghost-run", agentId: "sensenova-api", taskId: "" }),
    ).resolves.toBeUndefined();
  });

  it("abort terminates an in-flight run", async () => {
    const root = tmpRoot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowClient: LlmClient = {
      async chat() {
        await gate;
        throw new Error("should not matter");
      },
    };
    const adapter = new SensenovaApiAdapter(slowClient);
    const handle = await run(adapter, root);
    await adapter.abort(handle);
    release();
    const kinds: string[] = [];
    for await (const ev of adapter.collect(handle)) kinds.push(ev.kind);
    expect(kinds[kinds.length - 1]).toBe("aborted");
  });

  it("probe reflects key availability and constructor injection", async () => {
    const injected = new SensenovaApiAdapter(fakeClient("{}"));
    expect(await injected.probe()).toBe(true);
    const saved = process.env.SENSENOVA_API_KEY;
    delete process.env.SENSENOVA_API_KEY;
    try {
      const bare = new SensenovaApiAdapter();
      expect(await bare.probe()).toBe(false);
      process.env.SENSENOVA_API_KEY = "sk-test";
      expect(await bare.probe()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SENSENOVA_API_KEY;
      else process.env.SENSENOVA_API_KEY = saved;
    }
  });
});

/**
 * 快照遍历里的六处 `continue`（site 逐位点审计里全存活）。
 *
 * 共同形态与前几轮一致：**被跳过的条目在既有用例里永远是最后一个**，
 * 于是「跳过本项继续」与「直接终止循环」结果相同。
 * 真实后果是**后续文件的正文整段不进 prompt** —— 模型看不到它们，
 * 生成的补丁就会基于不完整的上下文，而且不报任何错。
 *
 * 这些跳过的方向各自都是安全/成本考量（凭据不外发、二进制不灌 prompt），
 * 但"跳过"绝不能退化成"到此为止"。
 */
async function promptFor(root: string): Promise<string> {
  const { client, prompts } = scriptedClient(['{"files":[{"path":"src/add.js","content":"x"}]}']);
  const adapter = new SensenovaApiAdapter(client);
  const handle = await run(adapter, root);
  await terminalText(adapter, handle);
  return prompts[0] ?? "";
}

describe("SensenovaApiAdapter · 快照遍历的跳过不能中断后续", () => {
  it("[278] 递归完一个子目录后，父目录的其余同级文件仍要进快照", async () => {
    // 第 278 行是 `walkStat(abs)` 之后那句 `continue;`，语义是
    // 「处理完这个子目录，继续父目录的下一个同级项」。改成 break 后，
    // 只要父目录里**先出现一个目录**，它后面的同级文件全部丢失。
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "a-sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "a-sub", "x.js"), "// sub", "utf8");
    fs.writeFileSync(path.join(root, "z-sibling.js"), "// sibling", "utf8");

    const p = await promptFor(root);
    expect(p).toContain("a-sub/x.js");
    expect(p).toContain("z-sibling.js");
  });

  it("[280] 既非文件也非目录的条目（junction）被跳过，但不中断后续文件", async () => {
    // 第 280 行 `if (!entry.isFile()) continue;`。实测 Windows 上
    // `fs.symlinkSync(target, path, "junction")` 产生的目录联接在
    // `readdirSync({withFileTypes:true})` 里是 isFile=false / isDirectory=false /
    // isSymbolicLink=true —— 正好落进这一支，且**创建 junction 不需要管理员权限**。
    const root = tmpRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ox-outside-"));
    dirs.push(outside);
    fs.symlinkSync(outside, path.join(root, "a-link"), "junction");
    fs.writeFileSync(path.join(root, "z-after-link.js"), "// after", "utf8");

    const p = await promptFor(root);
    // junction 本身不能被当成文件读（否则会把外部目录的内容灌进 prompt）
    expect(p).not.toContain("a-link");
    // 但它后面的同级文件必须照常进快照
    expect(p).toContain("z-after-link.js");
  });

  it("[284] 凭据类文件被跳过，但不中断后续文件", async () => {
    // 第 284 行 `if (isSecretLikeFile(rel)) continue;`。
    // `.env` 命中 `^\.env(\..+)?$`，且按字典序排在字母开头的文件之前 ——
    // 正是"被跳过的项排在前面"的最小场景。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=leak-me", "utf8");
    fs.writeFileSync(path.join(root, "z-after-secret.js"), "// after", "utf8");

    const p = await promptFor(root);
    expect(p).not.toContain("leak-me"); // 凭据正文绝不能进 prompt
    expect(p).toContain("z-after-secret.js"); // 但不能因此截断后面的文件
  });

  it("[325] 二进制文件被跳过，但不中断后续文件", async () => {
    // 第 325 行 `if (looksBinary(content)) continue;`（判定是「含 \\u0000」）。
    // 改成 break 后，遇到第一个二进制文件就停止收集 ——
    // 排在它后面的所有源码都不进 prompt。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "a-bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    fs.writeFileSync(path.join(root, "z-after-bin.js"), "// after", "utf8");

    const p = await promptFor(root);
    expect(p).not.toContain("a-bin.dat");
    expect(p).toContain("z-after-bin.js");
  });
});
