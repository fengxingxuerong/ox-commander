import { describe, expect, it } from "vitest";
import {
  changeStat,
  changesHeadline,
  collectChangedFiles,
  comparePaths,
  exportablePaths,
  threadBranchName,
  threadExportMessage,
  type FileChangeView,
} from "../shared/chat-changes";
import type { ChatEntry } from "../shared/chat-events";
import type { ChatFileChange } from "../shared/tools/spec";

/**
 * 右栏聚合逻辑（M2）。
 *
 * 用例按**坏法**写，不按"聚合成功了"写：
 *   · 同一文件多轮改动必须每条都在（撤销是按 turn 做的，只留最后一次会让
 *     "撤销"恢复出一个谁都没见过的中间态）；
 *   · 不可撤销的文件仍要出现（藏起来等于瞒）；
 *   · 顺序必须稳定（列表抖动 = 刚看到的文件跑到别处）。
 */

const change = (over: Partial<ChatFileChange> & Pick<ChatFileChange, "path" | "turn">): ChatFileChange => ({
  before: "旧\n内容\n",
  after: "新\n内容\n",
  created: false,
  revertable: true,
  ...over,
});

const entry = (changes: ChatFileChange[]): ChatEntry => ({
  id: `e-${Math.random()}`,
  ts: 1,
  kind: "tool_result",
  text: "补丁",
  result: { id: "t1", name: "apply_patch", ok: true, output: "", changes },
});

describe("comparePaths", () => {
  it("相等返回 0（自己不小于自己）", () => {
    // 这一条在 collectChangedFiles 里永远测不到：组来自 Map，同路径只有一个组，
    // 比较器收不到两个相等的 path。但"把相等报成大于"的比较器是坏掉的 ——
    // 换一个 sort 引擎就会让列表顺序随机。
    expect(comparePaths("a.ts", "a.ts")).toBe(0);
  });

  it("小于给负数、大于给正数（字典序）", () => {
    expect(comparePaths("a.ts", "b.ts")).toBeLessThan(0);
    expect(comparePaths("b.ts", "a.ts")).toBeGreaterThan(0);
  });
});

describe("collectChangedFiles", () => {
  it("没有补丁改动时是空列表（不是一条占位）", () => {
    expect(collectChangedFiles([])).toEqual([]);
    expect(
      collectChangedFiles([{ id: "e1", ts: 1, kind: "assistant", text: "只是说了句话" }]),
    ).toEqual([]);
  });

  it("同一文件多轮改动每条都留（撤销是按 turn 做的）", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "a.ts", turn: 1, before: "v0\n", after: "v1\n" })]),
      entry([change({ path: "a.ts", turn: 3, before: "v1\n", after: "v2\n" })]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].edits).toBe(2);
    expect(groups[0].history.map((h) => h.turn)).toEqual([3, 1]);
    // latest 指向最新一次：撤销按钮默认撤的是它，不是最早那次。
    expect(groups[0].latest.turn).toBe(3);
    expect(groups[0].latest.before).toBe("v1\n");
  });

  it("新建与删除都留着痕迹（before/after 的 null 不是「没有改动」）", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "new.ts", turn: 1, created: true, before: null, after: "刚建\n" })]),
    ]);
    expect(groups[0].latest.created).toBe(true);
    expect(groups[0].latest.before).toBeNull();
    expect(changeStat(groups[0].latest)).toEqual({ added: 1, deleted: 0 });
  });

  it("不可撤销的文件仍然出现在列表里（藏起来等于瞒）", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "big.ts", turn: 2, revertable: false, before: null, after: null })]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].revertable).toBe(false);
    // 没有内容可 diff：统计必须是 null 而不是 {0,0}（那会被读成"没变化"）。
    expect(changeStat(groups[0].latest)).toBeNull();
  });

  it("路径字典序稳定（不随 entries 到达顺序抖动）", () => {
    // 三个文件、且**与字典序不同的到达顺序**：两个元素的排序在部分反转的
    // 比较器下也可能碰巧正确（V8 对长度 2 的数组只做一次比较），
    // 三个以上才把"比较器写反了一半"这种假象逼出来。
    const shuffled = collectChangedFiles([
      entry([change({ path: "b.ts", turn: 1 })]),
      entry([change({ path: "c.ts", turn: 1 })]),
      entry([change({ path: "a.ts", turn: 1 })]),
    ]);
    expect(shuffled.map((g) => g.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    // 同一批里顺序相反，结果不变：排序依据是路径，不是到达次序。
    const sameBatch = collectChangedFiles([
      entry([change({ path: "b.ts", turn: 1 }), change({ path: "c.ts", turn: 1 }), change({ path: "a.ts", turn: 1 })]),
    ]);
    expect(sameBatch.map((g) => g.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("没有改动的条目不中断扫描（转录里绝大多数条目都没有 changes）", () => {
    const plain = (text: string): ChatEntry => ({ id: `p-${text}`, ts: 1, kind: "assistant", text });
    const groups = collectChangedFiles([
      entry([change({ path: "first.ts", turn: 1 })]),
      plain("读完了，现在改第二个"),
      plain("再说一句"),
      entry([change({ path: "second.ts", turn: 2 })]),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["first.ts", "second.ts"]);
  });

  it("同一批里的不同文件各归各的组", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "a.ts", turn: 1 }), change({ path: "b.ts", turn: 1 })]),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups.every((g) => g.edits === 1)).toBe(true);
  });
});

describe("changesHeadline", () => {
  it("空列表给空串（调用方据此不渲染头部）", () => {
    expect(changesHeadline([])).toBe("");
  });

  it("总数与不可撤销数量都说破", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "a.ts", turn: 1 })]),
      entry([change({ path: "big.ts", turn: 2, revertable: false, before: null, after: null })]),
    ]);
    expect(changesHeadline(groups)).toBe("2 个文件 · 2 处改动 · 1 个文件有不可撤销的改动");
  });

  it("全部可撤销时不提那句（不制造不存在的警告）", () => {
    const groups = collectChangedFiles([entry([change({ path: "a.ts", turn: 1 })])]);
    expect(changesHeadline(groups)).toBe("1 个文件 · 1 处改动");
  });
});

describe("线程导出（M5a）", () => {
  it("exportablePaths 去重并按路径稳定排序", () => {
    const groups = collectChangedFiles([
      entry([change({ path: "src/b.ts", turn: 1 }), change({ path: "src/a.ts", turn: 1 })]),
      entry([change({ path: "src/a.ts", turn: 2 })]),
    ]);
    expect(exportablePaths(groups)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("分支名只保留 git ref 安全字符，空 id 有兜底，长度受控", () => {
    expect(threadBranchName("chat-123", "20261021-120000")).toBe(
      "oxcommander/thread-chat-123-20261021-120000",
    );
    expect(threadBranchName("weird id/with spaces", "20261021-120000")).toBe(
      "oxcommander/thread-weird-id-with-spaces-20261021-120000",
    );
    expect(threadBranchName("", "stamp")).toBe("oxcommander/thread-thread-stamp");
    const long = threadBranchName("x".repeat(100), "20261021-120000");
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^oxcommander\/thread-/);
    expect(long).not.toMatch(/[^A-Za-z0-9._/-]/);
  });

  it("commit message 单行、限长、空标题有兜底", () => {
    expect(threadExportMessage("修登录\n  与结算", 3)).toBe("oxcommander: 修登录 与结算（3 个文件）");
    expect(threadExportMessage("   ", 0)).toBe("oxcommander: 会话改动（0 个文件）");
    expect(threadExportMessage("x".repeat(200), 1)).toContain("（1 个文件）");
  });
});

describe("changeStat", () => {
  const view = (over: Partial<FileChangeView>): FileChangeView => ({
    path: "a.ts",
    turn: 1,
    created: false,
    revertable: true,
    before: "",
    after: "",
    ...over,
  });

  it("before/after 都是 null 时是 null（不是零变化）", () => {
    expect(changeStat(view({ before: null, after: null }))).toBeNull();
  });

  it("新建文件按 after 行数计新增", () => {
    expect(changeStat(view({ before: null, after: "一\n二\n三\n" }))).toEqual({ added: 3, deleted: 0 });
  });

  it("删除文件按 before 行数计减少", () => {
    expect(changeStat(view({ before: "一\n二\n", after: null }))).toEqual({ added: 0, deleted: 2 });
  });

  it("内容一致时是零变化（不是 null）", () => {
    expect(changeStat(view({ before: "同\n", after: "同\n" }))).toEqual({ added: 0, deleted: 0 });
  });
});
