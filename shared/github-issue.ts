/**
 * GitHub issue 的结构化形态与"铺成需求"的成文处（摄入半边，2026-10-14）。
 *
 * 为什么在 shared：这个模板有**两个宿主**—— 桌面端拿它当项目种子
 * （src/store.ts），headless 拿它当 spec.issue 的解析结果（headless/run-spec.ts）。
 * 两处各写一串字符串，journal 的"需求匹配"就会因为一处标点改动而悄悄失配，
 * 断点续跑从此认不出自己的上一次运行。而 shared 是两侧唯一能同时 import 又
 * 不把 node 内置模块拖进浏览器包的地方（electron/context/github-readonly.ts
 * 要 import makeGitRunner，渲染层碰不得）。
 */

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
}

/**
 * 把一条 issue 铺成**需求文本**。
 *
 * 正文缺席时只留标题（空正文不是错误：一句话 issue 很常见）；`\r\n` 统一成
 * `\n`（Windows 上 gh 的输出带 CR，不归一化会让两台机器上的同一 issue 铺出
 * 不同字节的"同一需求"）。
 */
export function renderIssueRequirement(issue: GithubIssue): string {
  const body = issue.body.replace(/\r\n/g, "\n").trim();
  return [`GitHub Issue #${issue.number}：${issue.title}`, body].filter((part) => part !== "").join("\n\n");
}
