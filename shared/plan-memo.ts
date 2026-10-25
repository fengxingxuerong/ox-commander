import { clipBackgroundBlock } from "./project-conventions";

/**
 * 规划备忘（竞品吸收：项目级规划记忆，2026-10-25）。
 *
 * **缺的是什么**：规划的记忆此前只有 `requirement` 一个字符串与一份**覆盖式**落盘的
 * PRD —— 重新规划一次，上一版"为什么这么拆"就没了。竞品把"目标 / 决策 / 约束 / 历史"
 * 做成项目级常驻；这一格是本项目的对位物，形态刻意取**人写的文件**而不是数据库：
 * 可读、可 diff、可进 code review，与本仓库 `OX.md` / `AGENTS.md` 同一套读取纪律。
 *
 * **与 `OX.md` 的分工（这条必须写死，否则两份文件会互相长进去）**：
 * · `OX.md` / `AGENTS.md` 讲"这个项目的规矩"（技术栈偏好、目录纪律、命名口径）—— 长期稳定；
 * · `OX-PLAN.md` 讲"这一版我们决定了什么、为什么、否掉了什么"—— 随版本演替。
 *
 * **三条纪律照抄约定的那份**（它们被 `project-conventions` 的用例证明过了）：
 * 1. 备忘是**背景**，不是证据。它影响规划的起点，**不影响**"这份交付过没过门禁"；
 *    块内自带"与契约冲突时以契约为准"的声明。
 * 2. **超限必须说破**：截断时写清原文长度与上限，绝不静默丢。
 * 3. **缺席是常态**：没有这个文件的项目占多数，读不到只当没有、不产空块。
 *
 * **刻意不做**：平台**不自动写**这份文件（不做"从聊天记录/失败摘要里学出来"）。把模型的
 * 推测固化进下一次规划，等于给漂移装上加速度。要沉淀结论，由人写进去 —— 这是信任边界，
 * 不是懒。自动汇总**可核事实**（验证失败命令分布等）是另一个形态，单独立项。
 */

/** 规划备忘的文件名（项目根，单文件）。 */
export const PLAN_MEMO_FILE_NAME = "OX-PLAN.md";

/** 备忘块在提示里的标记（人从日志/提示里能认出这段来自哪个文件）。 */
export const PLAN_MEMO_MARKER = "【规划备忘（项目根的 OX-PLAN.md）】";

/** 备忘块总字符上限。超出部分不进上下文，并在块尾说破。 */
export const MAX_PLAN_MEMO_CHARS = 4000;

/**
 * 提示里**背景内容**的总预算（约定 + 规划备忘 + 外部上下文，2026-10-25）。
 *
 * ⚠️ 此前只有**分源**上限（约定 8000、备忘 4000、外部上下文每份 8000），**没有总额** ——
 * 三者相加可以无界增长，而规划提示的 token 预算就靠额度闸兜底（那已经太晚）。
 * 这里给的是**背景**的预算，不是整条提示：角色说明 / JSON schema / 规则 / 用户需求
 * 都不在其中，所以这个数不能读成"提示最多这么长"。
 */
export const MAX_BACKGROUND_CHARS = 24000;

/**
 * 把各背景块按预算拼起来；超预算的部分**整体退让**（不是随机截断）。
 *
 * 退让顺序 = 拼装顺序的**反过来**：越靠后的块越先被削。理由：约定是项目所有者写的
 * 长期规矩，备忘是这一版的临时取舍，外部上下文是拉来的背景 —— 后两者出局比丢掉规矩便宜。
 *
 * 若连第一个块都放不下，就按剩余额度截它并说破 —— 直接丢掉会造成"注释里说注入了、
 * 实际一个字没进"，那是最坏的一种安静失败。
 */
export function composeBackground(
  blocks: ReadonlyArray<{ label: string; text: string }>,
  maxChars: number,
): string {
  const kept: string[] = [];
  let used = 0;
  let dropped: string[] = [];
  for (const block of blocks) {
    if (block.text === "") continue;
    const cost = block.text.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > maxChars) {
      dropped.push(block.label);
      continue;
    }
    kept.push(block.text);
    used += cost;
  }

  const body = kept.join("\n\n");
  if (dropped.length === 0) return body;

  // 说破被退让的是什么 —— 预算这种账，静默减少等于假装没有上限。
  const note = `（背景总预算 ${maxChars} 字符已用尽：${dropped.join("、")} 未注入上下文。）`;
  const first = blocks.find((b) => b.text !== "");
  if (kept.length === 0 && first) {
    // 一个块都放不下：按额度截第一个并说破（不静默丢）。
    return clipBackgroundBlock(first.text, maxChars, first.label).concat(`\n${note}`);
  }
  return `${body}\n\n${note}`;
}

/**
 * 把读到的备忘正文包成一个提示块；空内容返回空串（调用方据此不拼）。
 *
 * 传进来的是**正文**而不是文件对象：备忘只有一个文件，没有"多文件拼接顺序"这件事，
 * 多一层结构只会多一个没人验证的分支。
 */
export function formatPlanMemoBlock(content: string): string {
  const body = content.trim();
  if (body === "") return "";
  const head = [
    PLAN_MEMO_MARKER,
    "以下是项目所有者写下的规划备忘：这一版我们决定了什么、为什么、否掉了什么。",
    "它是背景而不是证据：与任务契约冲突时以契约为准，也不代表任何交付已经过门禁。",
  ].join("\n");
  const full = `${head}\n${body}`;
  return clipBackgroundBlock(full, MAX_PLAN_MEMO_CHARS, "规划备忘");
}
