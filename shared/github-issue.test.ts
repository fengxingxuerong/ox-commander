import { describe, expect, it } from "vitest";
import { renderIssueRequirement } from "./github-issue";

/**
 * 摄入半边的成文处（2026-10-14）。
 *
 * 这个模板有**两个宿主**（桌面的项目种子 / headless 的 spec.issue 解析），
 * 所以它住在 shared 并由本文件钉死：两处各写一串字符串，journal 的"需求
 * 匹配"就会因为一处标点改动而悄悄失配 —— 断点续跑从此认不出上一次运行。
 */
describe("renderIssueRequirement（摄入半边的成文处）", () => {
  it("标题 + 正文两段，CRLF 归一成 LF", () => {
    expect(
      renderIssueRequirement({ number: 42, title: "支持暗色模式", body: "用户希望夜间使用不刺眼", state: "OPEN" }),
    ).toBe("GitHub Issue #42：支持暗色模式\n\n用户希望夜间使用不刺眼");
    // Windows 上 gh 的输出带 CR：不归一化，两台机器上的同一 issue 会铺出
    // 不同字节的"同一需求"（journal 匹配按字节）。
    expect(renderIssueRequirement({ number: 1, title: "t", body: "a\r\nb", state: "OPEN" })).toBe(
      "GitHub Issue #1：t\n\na\nb",
    );
  });

  it("正文缺席（空 / 纯空白）→ 只留标题，不留孤换行", () => {
    expect(renderIssueRequirement({ number: 7, title: "一句话", body: "", state: "OPEN" })).toBe(
      "GitHub Issue #7：一句话",
    );
    expect(renderIssueRequirement({ number: 7, title: "一句话", body: "   \n  ", state: "OPEN" })).toBe(
      "GitHub Issue #7：一句话",
    );
  });
});
