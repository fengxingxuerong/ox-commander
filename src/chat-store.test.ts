import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ChatSessionStore, type ChatSessionEnvelope } from "../electron/chat/session-store";
import type { ChatSessionSnapshot } from "../shared/chat-events";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-store-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function snapshot(sessionId: string, text: string): ChatSessionSnapshot {
  return {
    meta: {
      sessionId,
      rootAbs: "/p",
      startedAt: 1,
      updatedAt: 2,
      turns: 1,
      status: "done",
      mode: "workspace-write",
      approvalPolicy: "on-request",
      usageTokens: 7,
    },
    entries: [
      { id: "e-1", ts: 1, kind: "user", text },
      { id: "e-2", ts: 2, kind: "assistant", text: `${text} 的答复` },
    ],
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: `${text} 的答复` },
    ],
    toolProtocol: "text",
  };
}

describe("ChatSessionStore", () => {
  it("save / list / load：标题取首条用户消息，正文与消息都原样读回", () => {
    const store = new ChatSessionStore(path.join(root, "a"));
    store.save("p1", "/p", "sensenova", snapshot("chat-aaaa", "把 a 改成 b"));
    const list = store.list("p1");
    expect(list.map((s) => s.title)).toEqual(["把 a 改成 b"]);
    expect(list[0]?.sessionId).toBe("chat-aaaa");
    expect(store.list("p2")).toEqual([]);
    const loaded = store.load("chat-aaaa");
    expect(loaded?.snapshot.messages[0]?.content).toBe("把 a 改成 b");
    expect(loaded?.providerId).toBe("sensenova");
  });

  it("索引被删除后按会话文件重建；坏会话文件只跳过自己", () => {
    const dir = path.join(root, "b");
    const store = new ChatSessionStore(dir);
    store.save("p1", "/p", "sensenova", snapshot("chat-bbbb", "一"));
    store.save("p1", "/p", "sensenova", snapshot("chat-cccc", "二"));
    fs.rmSync(path.join(dir, "index.json"));
    expect(store.list("p1").map((s) => s.sessionId).sort()).toEqual(["chat-bbbb", "chat-cccc"]);

    fs.writeFileSync(path.join(dir, "sessions", "chat-dddd.json"), "{broken", "utf8");
    expect(store.load("chat-dddd")).toBeNull();
  });

  it("fork 产生独立会话：新 id、复制正文、源文件不被改动", () => {
    const dir = path.join(root, "c");
    const store = new ChatSessionStore(dir);
    store.save("p1", "/p", "sensenova", snapshot("chat-eeee", "原始"));
    const forked = store.fork("chat-eeee");
    expect(forked?.snapshot.meta.sessionId).not.toBe("chat-eeee");
    expect(forked?.title).toContain("分叉");
    expect(forked?.snapshot.entries.map((e) => e.text)).toEqual(["原始", "原始 的答复"]);
    expect(store.list("p1")).toHaveLength(2);
    expect(store.load("chat-eeee")?.snapshot.entries[0]?.text).toBe("原始");

    const forkedId = forked!.snapshot.meta.sessionId;
    expect(store.delete("chat-eeee")).toBe(true);
    expect(store.list("p1").map((s) => s.sessionId)).toEqual([forkedId]);
  });

  it("非法 id 不能拼出目录穿越路径", () => {
    const store = new ChatSessionStore(path.join(root, "d"));
    expect(store.load("../../etc/passwd")).toBeNull();
    expect(store.delete("../x")).toBe(false);
    const bad = snapshot("../evil", "x");
    expect(() => store.save("p1", "/p", "sensenova", bad)).toThrow(/非法会话 id/);
  });

  it("标题只认第一条非空 user：assistant 在前、空 user 在后都不算", () => {
    const store = new ChatSessionStore(path.join(root, "e"));
    const snap = snapshot("chat-ffff", "");
    snap.entries = [
      { id: "e-1", ts: 1, kind: "assistant", text: "不是用户" },
      { id: "e-2", ts: 2, kind: "user", text: "   " },
    ];
    store.save("p1", "/p", "sensenova", snap);
    expect(store.latest("p1")?.title).toBe("新会话");
  });

  it("list 无 projectId 返回全部；同 updatedAt 时按 startedAt 倒序", () => {
    const store = new ChatSessionStore(path.join(root, "sort"));
    const a = snapshot("chat-sort-a", "a");
    const b = snapshot("chat-sort-b", "b");
    a.meta.updatedAt = 10;
    a.meta.startedAt = 2;
    b.meta.updatedAt = 10;
    b.meta.startedAt = 1;
    store.save("p1", "/p", "sensenova", a);
    store.save("p2", "/p", "sensenova", b);
    expect(store.list()).toHaveLength(2);
    expect(store.list("p1").map((s) => s.sessionId)).toEqual(["chat-sort-a"]);
    // save 会把新会话插到索引前面，所以索引原序是 [b, a]；同 updatedAt 时
    // 只有 startedAt 能把它排回 [a, b] —— 平局分支被真的走到。
    expect(store.list().map((s) => s.sessionId)).toEqual(["chat-sort-a", "chat-sort-b"]);
  });

  it("delete：文件不存在返回 false；rmSync 抛错也返回 false 而不是假装删除", () => {
    const dir = path.join(root, "del");
    const store = new ChatSessionStore(dir);
    expect(store.delete("chat-missing")).toBe(false);

    // 用同名目录让 rmSync 抛错（非递归删目录会失败）。force 不会把它当文件删掉。
    fs.mkdirSync(path.join(dir, "sessions", "chat-dir.json"), { recursive: true });
    expect(store.delete("chat-dir")).toBe(false);
  });

  it("索引损坏/版本不对时从会话文件重建，不拿坏索引当真相", () => {
    const dir = path.join(root, "bad-index");
    const store = new ChatSessionStore(dir);
    store.save("p1", "/p", "sensenova", snapshot("chat-idx", "标题"));
    fs.writeFileSync(path.join(dir, "index.json"), "{broken", "utf8");
    expect(store.list("p1").map((s) => s.sessionId)).toEqual(["chat-idx"]);

    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ version: 99, sessions: [] }), "utf8");
    expect(store.list("p1").map((s) => s.sessionId)).toEqual(["chat-idx"]);
  });

  it("信封的每个必填字段/快照形状不对时 load 返回 null（不能把坏记录当会话恢复）", () => {
    const dir = path.join(root, "bad-envelope");
    const store = new ChatSessionStore(dir);
    const id = "chat-bad-env";
    store.save("p1", "/p", "sensenova", snapshot(id, "原始"));
    const file = path.join(dir, "sessions", `${id}.json`);
    const base = store.load(id)!;

    const cases: Array<[string, (env: ChatSessionEnvelope) => void]> = [
      ["version", (e) => ((e as { version: number }).version = 2)],
      ["projectId", (e) => ((e as { projectId: unknown }).projectId = 42)],
      ["rootAbs", (e) => ((e as { rootAbs: unknown }).rootAbs = null)],
      ["title", (e) => ((e as { title: unknown }).title = 7)],
      ["providerId", (e) => ((e as { providerId: unknown }).providerId = false)],
      ["snapshot", (e) => ((e as { snapshot: unknown }).snapshot = "x")],
      ["meta", (e) => ((e.snapshot as { meta: unknown }).meta = null)],
      ["meta.sessionId", (e) => ((e.snapshot.meta as { sessionId: unknown }).sessionId = 1)],
      ["entries", (e) => ((e.snapshot as { entries: unknown }).entries = {})],
      ["messages", (e) => ((e.snapshot as { messages: unknown }).messages = "x")],
      ["toolProtocol", (e) => ((e.snapshot as { toolProtocol: string }).toolProtocol = "xml")],
    ];
    for (const [label, corrupt] of cases) {
      const bad = structuredClone(base);
      corrupt(bad);
      fs.writeFileSync(file, JSON.stringify(bad), "utf8");
      expect(store.load(id), label).toBeNull();
    }

    for (const primitive of ["null", "[]", '"x"', "42", "true"]) {
      fs.writeFileSync(file, primitive, "utf8");
      expect(store.load(id), primitive).toBeNull();
    }
  });
});
