import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DIFF_LINES,
  diffText,
  looksBinary,
  splitLines,
  type FileDiff,
} from "../shared/text-diff";

describe("splitLines", () => {
  it("空串是零行（不是一行空行）", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("按 LF 切分并剥掉行尾；结尾换行不产生尾随空行", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("CRLF 的 CR 不进 text", () => {
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("looksBinary", () => {
  it("含 NUL 字节即二进制", () => {
    expect(looksBinary("abc\0def")).toBe(true);
    expect(looksBinary("abc")).toBe(false);
  });
});

describe("diffText", () => {
  it("两侧相同 ⇒ unchanged，且不给任何行", () => {
    const d = diffText("a\nb\n", "a\nb\n");
    expect(d.status).toBe("unchanged");
    expect(d.lines).toEqual([]);
    expect(d.added).toBe(0);
    expect(d.deleted).toBe(0);
    expect(d.beforeLines).toBe(2);
  });

  it("中间改一行 ⇒ 前缀后缀都是 same，改动行成对出现", () => {
    const d = diffText("head\nold\ntail\n", "head\nnew\ntail\n");
    expect(d.status).toBe("modified");
    expect(d.lines.map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
    expect(d.lines.map((l) => l.text)).toEqual(["head", "old", "new", "tail"]);
    expect(d.added).toBe(1);
    expect(d.deleted).toBe(1);
  });

  it("行号连续且两侧各自编号（del 无 afterNo，add 无 beforeNo）", () => {
    const d = diffText("a\nb\nc\n", "a\nB2\nc\n");
    const del = d.lines.find((l) => l.kind === "del")!;
    const add = d.lines.find((l) => l.kind === "add")!;
    expect(del.beforeNo).toBe(2);
    expect(del.afterNo).toBeUndefined();
    expect(add.afterNo).toBe(2);
    expect(add.beforeNo).toBeUndefined();
  });

  it("纯新增 ⇒ created，全部 add，afterNo 从 1 起", () => {
    const d = diffText(undefined, "x\ny\n");
    expect(d.status).toBe("created");
    expect(d.added).toBe(2);
    expect(d.deleted).toBe(0);
    // 行数也必须钉住：只断 kind 的话，三元互换（source 取错侧）后 lines 变空数组，
    // every 对空数组恒真 —— 那一格就悄悄活下来了（site 审计 @142 抓到过）。
    expect(d.lines).toHaveLength(2);
    expect(d.lines.every((l) => l.kind === "add" && l.afterNo !== undefined)).toBe(true);
  });

  it("纯删除 ⇒ deleted，全部 del", () => {
    const d = diffText("x\ny\n", undefined);
    expect(d.status).toBe("deleted");
    expect(d.added).toBe(0);
    expect(d.deleted).toBe(2);
    expect(d.lines).toHaveLength(2);
    expect(d.lines.every((l) => l.kind === "del" && l.beforeNo !== undefined)).toBe(true);
  });

  it("二进制 ⇒ binary，不给行，统计是 null 而不是 0", () => {
    const d = diffText("abc\0", "xyz\0");
    expect(d.status).toBe("binary");
    expect(d.lines).toEqual([]);
    // null = 拿不出这个数。报 0 会让界面显示"无变化"的反话。
    expect(d.added).toBeNull();
    expect(d.deleted).toBeNull();
  });

  it("只有一侧含 NUL 也算 binary（或运算子的单侧形态）", () => {
    // `||` 换成 `&&` 时，单侧二进制的判定会掉进 modified —— 那一格的
    // 行内容会带着 NUL 上屏。site 审计 @103 钉的就是这一格。
    expect(diffText("abc\0def", "clean").status).toBe("binary");
    expect(diffText("clean", "abc\0def").status).toBe("binary");
  });

  it("超过行数上限 ⇒ too-large，不给行，统计 null，截断标记为真", () => {
    const before = Array.from({ length: DEFAULT_MAX_DIFF_LINES + 1 }, (_, i) => `b${i}`).join("\n");
    const after = Array.from({ length: DEFAULT_MAX_DIFF_LINES + 1 }, (_, i) => `a${i}`).join("\n");
    const d = diffText(before, after);
    expect(d.status).toBe("too-large");
    expect(d.lines).toEqual([]);
    expect(d.truncated).toBe(true);
    expect(d.added).toBeNull();
    expect(d.deleted).toBeNull();
    expect(d.beforeLines).toBe(DEFAULT_MAX_DIFF_LINES + 1);
  });

  it("created 超上限同样 too-large（新建的大文件不硬渲染）", () => {
    const big = Array.from({ length: DEFAULT_MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    const d = diffText(undefined, big);
    expect(d.status).toBe("too-large");
    expect(d.truncated).toBe(true);
  });

  it("自定义 maxLines 被尊重", () => {
    const d = diffText("a\nb\nc\n", "a\nB\nc\n", { maxLines: 2 });
    expect(d.status).toBe("too-large");
  });

  it("只有一侧超行数上限也算 too-large（或运算子的单侧形态）", () => {
    // `||` 换成 `&&` 时，单侧超限会掉进 modified 去跑 DP —— 大文件照常全量
    // 渲染。site 审计 @159 钉的就是这一格。
    const big = Array.from({ length: DEFAULT_MAX_DIFF_LINES + 1 }, (_, i) => `b${i}`).join("\n");
    const d = diffText(big, "only-one-line\n", { maxLines: DEFAULT_MAX_DIFF_LINES });
    expect(d.status).toBe("too-large");
    expect(d.truncated).toBe(true);
    expect(d.lines).toEqual([]);
  });

  it("多段插入删除交错 ⇒ LCS 对齐，same 行不被拆散", () => {
    const before = ["1", "2", "3", "4", "5"].join("\n");
    const after = ["0", "2", "3", "9", "5", "6"].join("\n");
    const d = diffText(before, after);
    expect(d.status).toBe("modified");
    expect(d.lines.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["2", "3", "5"]);
    expect(d.added).toBe(3); // 0, 9, 6
    expect(d.deleted).toBe(2); // 1, 4
  });

  it("diff 结果可复原：same+add 拼回 after，same+del 拼回 before", () => {
    const before = "keep\ndrop\nend\n";
    const after = "keep\nadd\nend\n";
    const d: FileDiff = diffText(before, after);
    const backAfter = d.lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n");
    const backBefore = d.lines.filter((l) => l.kind !== "add").map((l) => l.text).join("\n");
    expect(backAfter).toBe(after.replace(/\n$/, ""));
    expect(backBefore).toBe(before.replace(/\n$/, ""));
  });

  it("空文件 → 有内容是 modified（文件存在，不是新建）；before 缺席才是 created", () => {
    // 空串与 undefined 是两回事：审计里 op=modify 的文件 before 可能是空文件，
    // op=create 的文件 before 根本不存盘（readArchived 给 undefined）。
    expect(diffText("", "x\n").status).toBe("modified");
    expect(diffText("x\n", "").status).toBe("modified");
    expect(diffText(undefined, "x\n").status).toBe("created");
  });

  it("只差结尾换行也算 modified（不静默忽略）", () => {
    const d = diffText("a\nb", "a\nb\n");
    expect(d.status).toBe("modified");
  });
});
