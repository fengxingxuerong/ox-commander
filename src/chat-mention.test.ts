import { describe, expect, it } from "vitest";

import { insertMention, mentionCandidates, mentionTokenAt } from "./chat-mention";

describe("chat mention", () => {
  it("识别光标前的 @token，并在空格或邮箱处停下", () => {
    expect(mentionTokenAt("看看 @src", 7)).toEqual({ start: 3, end: 7, query: "src" });
    expect(mentionTokenAt("@src/a.ts", 9)).toEqual({ start: 0, end: 9, query: "src/a.ts" });
    expect(mentionTokenAt("看看 @src 再说", 7)).toEqual({ start: 3, end: 7, query: "src" });
    expect(mentionTokenAt("看看 @src 再说", 8)).toBeNull();
    expect(mentionTokenAt("mail a@b.com", 12)).toBeNull();
  });

  it("候选先按文件名前缀，再按路径前缀与长度排序", () => {
    const files = ["src/utils.ts", "src/feature/alpha.ts", "docs/alpha.md", "alpha.test.ts", "src/beta.ts"];
    expect(mentionCandidates(files, "alpha")).toEqual(["alpha.test.ts", "docs/alpha.md", "src/feature/alpha.ts"]);
    expect(mentionCandidates(files, "src/")).toEqual(["src/beta.ts", "src/feature/alpha.ts", "src/utils.ts"]);
    expect(mentionCandidates(files, "zzz")).toEqual([]);
  });

  it("插入时把 token 替换为 @path，并在需要时补一个空格", () => {
    const text = "看看 @src 再说";
    expect(insertMention(text, { start: 3, end: 7, query: "src" }, "src/a.ts")).toEqual({
      text: "看看 @src/a.ts 再说",
      caret: 12,
    });
    expect(insertMention("@src", { start: 0, end: 4, query: "src" }, "src/a.ts")).toEqual({
      text: "@src/a.ts ",
      caret: 10,
    });
  });
});
