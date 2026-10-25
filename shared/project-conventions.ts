/**
 * 项目级约定注入（竞品缺口 B3）：项目根的 `OX.md` / `AGENTS.md` 自动进
 * 规划（PRD 提示）与执行（每个任务的 description）上下文。
 *
 * 为什么值得做：此前每次 run 都从零推项目约定（技术栈偏好、目录纪律、
 * 命名口径、禁改文件），而"推"这件事既烧 token 又不稳定 —— 同一句约定
 * 换个措辞，规划出来的任务边界就变了。约定写进文件、每次原样带进上下文，
 * 才谈得上"跨 run 一致的起点"。
 *
 * 三条设计纪律：
 *
 * 1. **约定是背景，不是合同**。块内自己声明"与任务契约冲突时以契约为准" ——
 *    契约是任务级的强制条款（平台注入），约定是项目所有者的默认偏好。
 *    把它放在契约块**上方**，读的人（模型）先看背景再读合同。
 * 2. **超限必须说破**。总长上限 `MAX_CONVENTIONS_CHARS`，截断时写明"原 N 字符、
 *    上限 M、后面的约定没进上下文" —— 静默截断会让模型以为自己看全了。
 * 3. **缺席是常态、不是错误**。没有这两个文件的项目占多数；读不到只当没有，
 *    不报错、不产空块（空块等于一个没有内容的标题，纯噪声）。
 */

/** 按优先级读取的约定文件（同目录下按此顺序拼接）。 */
export const CONVENTION_FILE_NAMES = ["OX.md", "AGENTS.md"] as const;

/** 约定块在提示里的标记（便于人从日志里认出"这段来自哪个文件"）。 */
export const CONVENTIONS_MARKER = "【项目约定（项目根的 OX.md / AGENTS.md）】";

/** 约定块总字符上限。超出部分不进上下文，并在块尾说明。 */
export const MAX_CONVENTIONS_CHARS = 8000;

/**
 * 背景块截断的共用判据（项目约定与规划备忘同一套纪律，2026-10-25）。
 *
 * 为什么抽出来：两处都要"超限 → 截断 → **说破**原文长度与上限"，而说破的措辞
 * 一旦两处各写一份就会漂（一处说原文长度、另一处只说上限）。这里只留一条，
 * 主语由 `what` 传进来 —— 差异进句子，不进分支。
 */
export function clipBackgroundBlock(full: string, maxChars: number, what: string): string {
  if (full.length <= maxChars) return full;
  const kept = full.slice(0, maxChars);
  return (
    `${kept}\n` +
    `（已截断：${what}原文共 ${full.length} 字符，上限 ${maxChars}；` +
    `上面的内容之后还有内容没进上下文 —— 需要时请自行拆分文件。）`
  );
}

export interface ConventionFile {
  /** 文件名（OX.md / AGENTS.md）。 */
  name: string;
  content: string;
}

/**
 * 把读到的约定文件拼成一个提示块；没有内容时返回空串（调用方据此不拼）。
 *
 * 输出形如：
 * ```
 * 【项目约定（项目根的 OX.md / AGENTS.md）】
 * 以下是项目所有者写下的约定……（不覆盖任务契约）
 * ### OX.md
 * <内容>
 * ### AGENTS.md
 * <内容>
 * ```
 */
export function formatConventionsBlock(entries: readonly ConventionFile[]): string {
  const nonEmpty = entries.filter((e) => e.content.trim() !== "");
  if (nonEmpty.length === 0) return "";

  const head = [
    CONVENTIONS_MARKER,
    "以下是项目所有者写下的项目级约定，规划与实现时遵循。",
    "它们是背景而不是合同：与本次任务的契约条款冲突时，以契约为准。",
  ].join("\n");

  const sections = nonEmpty.map((e) => `### ${e.name}\n${e.content.trim()}`);
  const body = sections.join("\n\n");

  const full = `${head}\n${body}`;
  // 截断与"说破"走共用判据（`clipBackgroundBlock`）：约定与规划备忘是同一套纪律，
  // 措辞分两份写就一定会漂。
  return clipBackgroundBlock(full, MAX_CONVENTIONS_CHARS, "约定");
}
