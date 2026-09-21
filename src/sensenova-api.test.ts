import { describe, expect, it, vi } from "vitest";
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

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sensenova-"));
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
    expect(() => parseFilePayload(null)).toThrowError(/files/);
    expect(() => parseFilePayload("a string")).toThrowError(/files/);
    expect(() => parseFilePayload({})).toThrowError(/files/);
    expect(() => parseFilePayload({ files: "not-an-array" })).toThrowError(/files/);
  });
});

describe("SensenovaApiAdapter", () => {
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
