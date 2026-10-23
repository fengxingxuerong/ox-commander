import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ToolRunner, compareEntryNames } from "../electron/chat/tool-runner";
import type { ChatApprovalRequest } from "../shared/chat-events";
import type { ToolCall } from "../shared/tools/spec";
import type { Skill } from "../shared/skills";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-runner-"));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

const call = (name: ToolCall["name"], args: Record<string, unknown>, id = "t-1"): ToolCall => ({ id, name, args });

function runner(root: string, overrides: Partial<ConstructorParameters<typeof ToolRunner>[0]> = {}): ToolRunner {
  return new ToolRunner({ rootAbs: root, approvalPolicy: "never", ...overrides });
}

describe("ToolRunner · 目录遍历与检索", () => {
  it("目录项按名字升序，大小相等返回 0（排序不能只对一半输入成立）", () => {
    expect(["z", "a", "m"].map((name) => ({ name })).sort(compareEntryNames).map((e) => e.name)).toEqual([
      "a",
      "m",
      "z",
    ]);
    expect(compareEntryNames({ name: "same" }, { name: "same" })).toBe(0);
    expect(compareEntryNames({ name: "b" }, { name: "a" })).toBe(1);
  });

  it("list_dir 跳过不可读项/构建目录后仍继续列后面的条目", async () => {
    const root = project();
    write(root, ".env", "SECRET=1\n");
    write(root, "a.txt", "a");
    write(root, "dist/out.js", "x");
    write(root, "z.txt", "z");
    const res = await runner(root).run(call("list_dir", {}));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("a.txt");
    expect(res.output).toContain("z.txt");
    expect(res.output).not.toContain(".env");
    expect(res.output).not.toContain("dist/");
    // 顺序也要确定：排序分支判反时，模型与测试看到的"先遇到谁"都会漂。
    expect(res.output.split("\n").filter(Boolean)).toEqual(["a.txt", "z.txt"]);
  });

  it("空目录的理由带上目录名，而不是只剩一个点", async () => {
    const root = project();
    fs.mkdirSync(path.join(root, "empty"));
    const res = await runner(root).run(call("list_dir", { path: "empty" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("empty");
  });

  it("depth：数字才递归，字符串走默认一层", async () => {
    const root = project();
    write(root, "nested/file.txt", "x");
    const deep = await runner(root).run(call("list_dir", { depth: 2 }));
    expect(deep.output).toContain("nested/file.txt");
    const shallow = await runner(root).run(call("list_dir", { depth: "2" }));
    expect(shallow.output).not.toContain("nested/file.txt");
  });

  it("grep maxMatches：数字限流，字符串走默认值", async () => {
    const root = project();
    write(root, "hits.txt", "hit\nhit\nhit\n");
    const limited = await runner(root).run(call("grep_files", { pattern: "hit", maxMatches: 1 }));
    expect(limited.output.split("\n").filter((l) => l.includes("hits.txt:")).length).toBe(1);
    const asString = await runner(root).run(call("grep_files", { pattern: "hit", maxMatches: "1" }));
    expect(asString.output.split("\n").filter((l) => l.includes("hits.txt:")).length).toBe(3);
  });

  it("grep 跳过超大文件后继续扫后面的文件", async () => {
    const root = project();
    write(root, "a-big.txt", "x".repeat(600 * 1024));
    write(root, "b-hit.txt", "needle\n");
    const res = await runner(root).run(call("grep_files", { pattern: "needle" }));
    expect(res.output).toContain("b-hit.txt:1");
  });

  it("grep 同一文件里前面行不命中时继续扫后面的行", async () => {
    const root = project();
    write(root, "multi.txt", "nothing\nneedle here\n");
    const res = await runner(root).run(call("grep_files", { pattern: "needle" }));
    expect(res.output).toContain("multi.txt:2");
  });

  it("grep 遇到读失败的文件后继续扫后面的文件（注入读函数构造 EACCES）", async () => {
    const root = project();
    write(root, "a-broken.txt", "x");
    write(root, "b-hit.txt", "needle\n");
    const r = new ToolRunner({
      rootAbs: root,
      approvalPolicy: "never",
      readTextFile: (abs) => {
        if (abs.endsWith("a-broken.txt")) throw new Error("EACCES");
        return fs.readFileSync(abs, "utf8");
      },
    });
    const res = await r.run(call("grep_files", { pattern: "needle" }));
    expect(res.output).toContain("b-hit.txt:1");
  });

  it("read_file 超长输出在结果上带 truncatedFrom", async () => {
    const root = project();
    write(root, "long.txt", "x".repeat(9000));
    const res = await runner(root).run(call("read_file", { path: "long.txt" }));
    expect(res.ok).toBe(true);
    expect(res.truncatedFrom).toBeGreaterThan(8000);
    expect(res.output).toMatch(/已截断/);
  });
});

describe("ToolRunner · 补丁改动记录", () => {
  it("同一补丁里的 add/update/delete 各自记录 created 与操作名", async () => {
    const root = project();
    write(root, "update.txt", "a\nb\n");
    write(root, "delete.txt", "old\n");
    const res = await runner(root).run(
      call("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: new.txt",
          "+n",
          "*** Update File: update.txt",
          "@@ ",
          " a",
          "-b",
          "+B",
          "*** Delete File: delete.txt",
          "*** End Patch",
        ].join("\n"),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("新建 new.txt");
    expect(res.output).toContain("修改 update.txt");
    expect(res.output).toContain("删除 delete.txt");
    expect(res.changes).toHaveLength(3);
    expect(res.changes?.find((c) => c.path === "new.txt")?.created).toBe(true);
    expect(res.changes?.find((c) => c.path === "delete.txt")?.created).toBe(false);
    expect(fs.existsSync(path.join(root, "delete.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("n");
  });

  it("超过可记录上限的改动仍落盘，但标记 revertable=false", async () => {
    const root = project();
    write(root, "big.txt", "x".repeat(600 * 1024));
    const res = await runner(root).run(
      call("apply_patch", { patch: "*** Begin Patch\n*** Delete File: big.txt\n*** End Patch" }),
    );
    expect(res.ok).toBe(true);
    expect(res.changes?.[0]).toMatchObject({ path: "big.txt", revertable: false, before: null, after: null });
  });

  it("部分失败时保留已应用文件的 changes；解析失败则没有 changes", async () => {
    const root = project();
    const partial = await runner(root).run(
      call("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: partial.txt",
          "+x",
          "*** Update File: missing.txt",
          "-a",
          "+b",
          "*** End Patch",
        ].join("\n"),
      }),
    );
    expect(partial.ok).toBe(false);
    expect(partial.changes?.map((c) => c.path)).toEqual(["partial.txt"]);
    expect(fs.existsSync(path.join(root, "partial.txt"))).toBe(true);

    const parseFail = await runner(root).run(call("apply_patch", { patch: "no patch here" }));
    expect(parseFail.ok).toBe(false);
    expect(parseFail.changes).toBeUndefined();
  });

  it("删除文件后继续处理同一补丁里的后续文件", async () => {
    const root = project();
    write(root, "delete-me.txt", "old\n");
    const res = await runner(root).run(
      call("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Delete File: delete-me.txt",
          "*** Add File: after.txt",
          "+after",
          "*** End Patch",
        ].join("\n"),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.changes?.map((c) => c.path)).toEqual(["delete-me.txt", "after.txt"]);
    expect(fs.readFileSync(path.join(root, "after.txt"), "utf8")).toBe("after");
  });

  it("无上下文的纯新增追加到末尾，并把这件事写进结果", async () => {
    const root = project();
    write(root, "append.txt", "a\n");
    const res = await runner(root).run(
      call("apply_patch", { patch: "*** Begin Patch\n*** Update File: append.txt\n+b\n*** End Patch" }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("追加到文件末尾");
    expect(fs.readFileSync(path.join(root, "append.txt"), "utf8")).toBe("a\nb\n");
  });
});

describe("ToolRunner · 命令与审批", () => {
  it("命令输出超限时结果带 truncatedFrom", async () => {
    const root = project();
    write(root, "big-output.js", 'process.stdout.write("y".repeat(9000));\n');
    const res = await runner(root).run(call("run_command", { command: "node", args: ["big-output.js"] }));
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.truncatedFrom).toBeGreaterThan(8000);
  });

  it("命令非零退出 ⇒ ok=false 且理由带退出码", async () => {
    const root = project();
    write(root, "exit3.js", "process.exit(3);\n");
    const res = await runner(root).run(call("run_command", { command: "node", args: ["exit3.js"] }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("退出码 3");
  });

  it("on-request 的 approvalCommands 真的按命令名命中（command 必须进裁决）", async () => {
    const root = project();
    const asked: string[] = [];
    const r = runner(root, {
      approvalPolicy: "on-request",
      approvalCommands: ["node"],
      requestApproval: async (req) => {
        asked.push(req.command ?? "");
        return { granted: true, scope: "once" };
      },
    });
    const res = await r.run(call("run_command", { command: "node", args: ["-v"] }));
    expect(res.ok).toBe(true);
    expect(asked).toEqual(["node"]);
  });

  it("审批请求带上 tool 对应的字段：补丁有 paths，命令有 command/args", async () => {
    const root = project();
    write(root, "a.txt", "x");
    const requests: ChatApprovalRequest[] = [];
    const r = runner(root, {
      approvalPolicy: "untrusted",
      requestApproval: async (req) => {
        requests.push(req);
        return { granted: true, scope: "once" };
      },
    });
    await r.run(call("apply_patch", { patch: "*** Begin Patch\n*** Add File: b.txt\n+x\n*** End Patch" }));
    await r.run(call("run_command", { command: "node", args: ["-v"] }));
    expect(requests[0]?.tool).toBe("apply_patch");
    expect(requests[0]?.paths).toEqual(["b.txt"]);
    expect(requests[0]?.command).toBeUndefined();
    expect(requests[0]?.args).toBeUndefined();
    expect(requests[1]?.tool).toBe("run_command");
    expect(requests[1]?.command).toBe("node");
    expect(requests[1]?.args).toEqual(["-v"]);
    expect(requests[1]?.paths).toBeUndefined();
  });
});

/**
 * 并行写冲突（M4c · P1）。
 *
 * 不走 worktree，所以"两条线程撞同一个文件"只能靠**提示 + 人拍板**。这里守的是
 * 那个闸门本身：撞上了要问、问的时候要带"谁刚动过"的事实、拒绝就不许写、
 * 没有审批通道时按拒绝（fail-closed），以及**自己的写不算冲突** ——
 * 最后一条漏了的话，"补丁打一半接着补"会被自己拦住。
 */
describe("ToolRunner · 并行写冲突（M4c）", () => {
  const patch = (rel: string, text: string): string =>
    ["*** Begin Patch", `*** Add File: ${rel}`, `+${text}`, "*** End Patch"].join("\n");

  it("撞上别的线程刚改的文件：先问一句，理由里带线程与多久之前", async () => {
    const root = project();
    const requests: ChatApprovalRequest[] = [];
    const r = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [{ sessionId: "chat-other", path: "a.txt", ts: Date.now() - 30_000 }],
      requestApproval: async (req) => {
        requests.push(req);
        return { granted: true };
      },
    });
    const res = await r.run(call("apply_patch", { patch: patch("a.txt", "y") }));
    expect(res.ok).toBe(true);
    expect(requests[0]?.requestId).toBe("conflict-t-1");
    expect(requests[0]?.reason).toContain("a.txt");
    expect(requests[0]?.reason).toContain("30 秒前");
    expect(requests[0]?.paths).toEqual(["a.txt"]);
  });

  it("人拒绝 = 不写（盘上还是原内容）", async () => {
    const root = project();
    write(root, "a.txt", "原内容");
    const r = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [{ sessionId: "chat-other", path: "a.txt", ts: Date.now() - 1_000 }],
      requestApproval: async () => ({ granted: false, reason: "等它跑完" }),
    });
    const res = await r.run(call("apply_patch", { patch: patch("a.txt", "新内容") }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("等它跑完");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("原内容");
  });

  it("没有审批通道时按拒绝（保护不能因为没有通道就消失）", async () => {
    const root = project();
    const r = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [{ sessionId: "chat-other", path: "a.txt", ts: Date.now() - 1_000 }],
    });
    const res = await r.run(call("apply_patch", { patch: patch("a.txt", "x") }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("没有审批通道");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("自己刚改过的不算冲突（补丁接着打是最常见的正常动作）", async () => {
    const root = project();
    let asked = 0;
    const r = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [{ sessionId: "chat-mine", path: "a.txt", ts: Date.now() - 1_000 }],
      requestApproval: async () => {
        asked += 1;
        return { granted: true };
      },
    });
    const res = await r.run(call("apply_patch", { patch: patch("a.txt", "x") }));
    expect(res.ok).toBe(true);
    expect(asked).toBe(0);
  });

  it("窗口外的写不算冲突；没注入 sessionId 时压根不检测", async () => {
    const root = project();
    const stale = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [{ sessionId: "chat-other", path: "a.txt", ts: Date.now() - 10 * 60_000 - 5_000 }],
      requestApproval: async () => ({ granted: false }),
    });
    expect((await stale.run(call("apply_patch", { patch: patch("a.txt", "x") }))).ok).toBe(true);

    // 单线程/CLI 形态：不注入 sessionId —— 把自己的历史当冲突去拦自己是错的。
    const single = runner(root, {
      conflictWrites: () => [{ sessionId: "chat-other", path: "b.txt", ts: Date.now() }],
      requestApproval: async () => ({ granted: false }),
    });
    expect((await single.run(call("apply_patch", { patch: patch("b.txt", "x") }))).ok).toBe(true);
  });

  it("自定义窗口生效：宿主给的窗口比默认短时，稍旧的写就不算并发", async () => {
    const root = project();
    // 5 秒前的写：默认窗口（10 分钟）算冲突，1 秒窗口不算。
    const writes = () => [{ sessionId: "chat-other", path: "a.txt", ts: Date.now() - 5_000 }];
    const wide = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: writes,
      requestApproval: async () => ({ granted: false }),
    });
    expect((await wide.run(call("apply_patch", { patch: patch("a.txt", "x") }))).ok).toBe(false);

    const narrow = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: writes,
      conflictWindowMs: 1_000,
      requestApproval: async () => ({ granted: false }),
    });
    expect((await narrow.run(call("apply_patch", { patch: patch("a.txt", "y") }))).ok).toBe(true);
  });

  it("写成功后回灌台账（别的线程下一步才看得见）", async () => {
    const root = project();
    const recorded: string[] = [];
    const r = runner(root, {
      sessionId: "chat-mine",
      conflictWrites: () => [],
      onWrite: (paths) => recorded.push(...paths),
    });
    await r.run(call("apply_patch", { patch: patch("a.txt", "x") }));
    expect(recorded).toEqual(["a.txt"]);
  });
});

/**
 * read_skill（M6b）。判错的形态全是静默的「技能没生效」：名字查不到、停用被当
 * 不存在、全局技能拿不到、会话开始后文件被删 —— 所以逐条钉住，并且**名字永远
 * 不参与路径拼接**这一条放在最前面：模型给的 name 只在注入表里查。
 */
describe("ToolRunner · read_skill", () => {
  const skill = (over: Partial<Skill> = {}): Skill => ({
    name: "run-verify",
    description: "跑本项目 verify 并解读失败",
    origin: "project",
    path: ".ox/skills/run-verify/SKILL.md",
    bodyChars: 12,
    enabled: true,
    ...over,
  });

  it("项目技能给全文（目录块说有什么，工具就真的给得出）", async () => {
    const root = project();
    write(root, ".ox/skills/run-verify/SKILL.md", "---\nname: run-verify\ndescription: 跑 verify\n---\n第一步跑门禁。\n");
    const res = await runner(root, { skills: [skill()] }).run(call("read_skill", { name: "run-verify" }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("第一步跑门禁。");
  });

  it("名字不在表里就是「没有这个技能」，并把可用名字列出来 —— 名字不参与路径拼接", async () => {
    const root = project();
    // 模型给的 name 就算长得像路径，也只是拿去表里查 —— 盘上真有这份文件也不给。
    write(root, ".ox/skills/anything/SKILL.md", "正文");
    const res = await runner(root, { skills: [skill()] }).run(call("read_skill", { name: "../../outside" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("没有这个技能：../../outside");
    expect(res.reason).toContain("run-verify");
    // 没注入表时同样报「没有技能可读」，而不是自己扫盘。
    const noTable = await runner(root).run(call("read_skill", { name: "run-verify" }));
    expect(noTable.ok).toBe(false);
    expect(noTable.reason).toContain("本会话没有可用技能");
  });

  it("停用的技能点名拒绝（停用不等于不存在，理由带上 .disabled）", async () => {
    const root = project();
    write(root, ".ox/skills/paused/SKILL.md", "正文");
    const res = await runner(root, {
      skills: [skill({ name: "paused", path: ".ox/skills/paused/SKILL.md", enabled: false })],
    }).run(call("read_skill", { name: "paused" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("已停用");
    expect(res.reason).toContain(".disabled");
  });

  it("全局技能以技能目录根为界，一样给得出全文（项目外 ≠ 读不到）", async () => {
    const root = project();
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ox-skills-global-"));
    roots.push(globalRoot);
    write(globalRoot, "deploy/SKILL.md", "---\nname: deploy\ndescription: 部署\n---\n全局部署流程。\n");
    const res = await runner(root, {
      skills: [skill({ name: "deploy", origin: "global", path: path.join(globalRoot, "deploy", "SKILL.md") })],
      skillGlobalRootAbs: globalRoot,
    }).run(call("read_skill", { name: "deploy" }));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("全局部署流程。");
  });

  it("全局技能根缺席时报「不可用」，而不是把全局技能当不存在", async () => {
    const root = project();
    const res = await runner(root, {
      skills: [skill({ name: "deploy", origin: "global", path: path.join(root, "deploy", "SKILL.md") })],
    }).run(call("read_skill", { name: "deploy" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("全局技能目录在本会话不可用");
  });

  it("会话开始后技能文件被删：点名「可能被删除」，不装作从来不存在", async () => {
    const root = project();
    // 表里有、盘上没有 —— 目录块刚说过有这个技能。
    const res = await runner(root, { skills: [skill()] }).run(call("read_skill", { name: "run-verify" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("技能文件不存在");
    expect(res.reason).toContain("可能被删除");
  });

  it("超限的技能文件拒绝（与 read_file 同一把尺子），话术点名「技能文件」", async () => {
    const root = project();
    write(root, ".ox/skills/big/SKILL.md", "x".repeat(600 * 1024));
    const res = await runner(root, { skills: [skill({ name: "big", path: ".ox/skills/big/SKILL.md" })] }).run(
      call("read_skill", { name: "big" }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/技能文件过大/);
  });

  it("技能文件变成目录（形态检查）：按「不是文件」拒绝", async () => {
    const root = project();
    write(root, ".ox/skills/odd/SKILL.md/inner.txt", "这使 SKILL.md 成为目录");
    const res = await runner(root, { skills: [skill({ name: "odd", path: ".ox/skills/odd/SKILL.md" })] }).run(
      call("read_skill", { name: "odd" }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("不是文件");
  });
});
