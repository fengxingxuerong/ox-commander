/**
 * 右栏改动审查的**纯**派生逻辑（M2）。
 *
 * 为什么单独一层：Codex 式工作台的右栏回答的是"这个线程动过哪些文件、每处
 * 能不能退回去"。这个答案要从整条转录里聚合出来，而聚合规则有两条容易写错
 * 且**错了不抛异常**的地方：
 *
 * 1. 同一个文件在多个用户回合里被改过。撤销是按 (turn, path) 做的 ——
 *    撤销第 3 轮把这个文件恢复到"第 3 轮补丁之前"，不是恢复到项目初始状态。
 *    所以视图必须保留**每一次**改动，只留最后一次会让"撤销"按钮撤出一个
 *    谁都没见过的中间态。
 * 2. `revertable: false` 的文件（超过记录上限，before/after 为 null）不能给
 *    可点的撤销按钮 —— 但它**仍然要出现在列表里**：操作者需要知道"这里动过，
 *    只是退不回去"，藏起来等于瞒。
 *
 * 本模块不碰 diff 计算（那是 `shared/text-diff` 的职责），只做归组与排序。
 */

import type { ChatEntry } from "./chat-events";
import type { ChatFileChange } from "./tools/spec";

/** 一次 (文件, 回合) 的改动记录。 */
export interface FileChangeView {
  path: string;
  turn: number;
  created: boolean;
  revertable: boolean;
  before: string | null;
  after: string | null;
}

/** 按路径归组后的文件视图：一个文件在右栏里占一行，行内可展开它的各轮改动。 */
export interface ChangedFileGroup {
  path: string;
  /** 改动次数（同一文件被几个回合碰过）。 */
  edits: number;
  /** 最近一次改动（默认展示与撤销的对象）。 */
  latest: FileChangeView;
  /** 全部改动，按 turn 倒序（最新在上）。 */
  history: FileChangeView[];
  /** 只要有一轮不可撤销，整行就不能给"一键全撤" —— 但单轮按钮照常给。 */
  revertable: boolean;
}

/**
 * 路径排序规则。
 *
 * 单独导出是为了让它**可被直接测**：相等时必须返回 0（"自己不小于自己"），
 * 这一点在 `collectChangedFiles` 里永远测不到 —— 那里的组来自 `Map`，
 * 同路径只会有一个组，比较器永远收不到两个相等的 path。而一个把"相等"
 * 报成"大于"的比较器是坏掉的比较器：换一个 sort 实现（或不稳定的引擎）
 * 就会让列表顺序随机。
 */
export function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 从转录里聚合改动文件。
 *
 * 顺序是**稳定**的（按路径字典序 + 组内 turn 倒序），不依赖 entries 的到达顺序
 * 之外的任何东西：列表抖动会让"刚看到的文件跑到了别处"。
 */
export function collectChangedFiles(entries: readonly ChatEntry[]): ChangedFileGroup[] {
  const byPath = new Map<string, FileChangeView[]>();
  for (const entry of entries) {
    const changes = entry.result?.changes;
    if (!changes || changes.length === 0) continue;
    for (const c of changes) {
      const view: FileChangeView = {
        path: c.path,
        turn: c.turn,
        created: c.created,
        revertable: c.revertable,
        before: c.before,
        after: c.after,
      };
      const list = byPath.get(c.path);
      if (list) list.push(view);
      else byPath.set(c.path, [view]);
    }
  }
  const groups: ChangedFileGroup[] = [];
  for (const [path, history] of byPath) {
    // turn 倒序：最新一次在最前面（同一 turn 内理论上只会有一次，防御性排序即可）。
    history.sort((a, b) => b.turn - a.turn);
    groups.push({
      path,
      edits: history.length,
      latest: history[0],
      history,
      revertable: history.every((h) => h.revertable),
    });
  }
  groups.sort((a, b) => comparePaths(a.path, b.path));
  return groups;
}

/** 右栏头部那句总数：几个文件、几处改动、几处退不回去。 */
export function changesHeadline(groups: readonly ChangedFileGroup[]): string {
  if (groups.length === 0) return "";
  const edits = groups.reduce((n, g) => n + g.edits, 0);
  const stuck = groups.filter((g) => !g.revertable).length;
  const head = `${groups.length} 个文件 · ${edits} 处改动`;
  return stuck > 0 ? `${head} · ${stuck} 个文件有不可撤销的改动` : head;
}

/**
 * 数文本的行数。
 *
 * 尾部换行不计成一行：`"a\nb\n"` 是两行而不是三行 —— 直接 `split("\n").length`
 * 会把结尾那个空串也数进去，于是"每行末尾都有换行"的常规文件永远多报一行。
 */
function countLines(text: string): number {
  if (text === "") return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

/** 单个改动记录的 diff 统计文案（`+added/-deleted`）；null = 没有可 diff 的内容。 */
export function changeStat(change: FileChangeView): { added: number; deleted: number } | null {
  if (change.before === null && change.after === null) return null;
  const before = change.before ?? "";
  const after = change.after ?? "";
  if (before === after) return { added: 0, deleted: 0 };
  // 行数差给的是量级而不是精确 diff：精确的 +/− 由 text-diff 在渲染时算，
  // 这里只做列表里的速览数字，避免为每行都跑一次完整 diff。
  const beforeLines = countLines(before);
  const afterLines = countLines(after);
  return {
    added: Math.max(0, afterLines - beforeLines),
    deleted: Math.max(0, beforeLines - afterLines),
  };
}

/**
 * 一条线程要导出成 git 分支的路径集合：去重 + 稳定排序。
 *
 * 只用 ReviewRail 看得到的 `apply_patch` 改动 —— 命令产生的改动没有 before/after，
 * 不属于"这条线程可审阅的改动集"。路径本身仍是相对项目根的写法，真正的包含
 * 判定在 git-export 的显式路径校验里再做一次。
 */
export function exportablePaths(groups: readonly ChangedFileGroup[]): string[] {
  const seen = new Set<string>();
  for (const group of groups) seen.add(group.path);
  return [...seen].sort(comparePaths);
}

/**
 * 线程导出的分支名。session id 是外部输入（可能来自恢复的旧记录），所以只保留
 * git ref 安全字符并裁剪长度；stamp 由宿主生成（本地时间）。
 *
 * 前缀带 `thread-` 而不是复用 `delivery-`：两者在 `git branch` 里一眼可分，
 * 排查"这个分支是谁写的"时不必先翻凭据。
 */
export function threadBranchName(sessionId: string, stamp: string): string {
  const id =
    sessionId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-._]+/, "")
      .slice(0, 24) || "thread";
  const safeStamp = stamp.replace(/[^A-Za-z0-9-]+/g, "").slice(0, 20) || "now";
  return `oxcommander/thread-${id}-${safeStamp}`;
}

/** 线程导出的 commit message（单行、限长；git 走参数数组，不存在注入面）。 */
export function threadExportMessage(title: string, fileCount: number): string {
  const clean = title.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "会话改动";
  return `oxcommander: ${clean}（${Math.max(0, fileCount)} 个文件）`;
}

export type { ChatFileChange };
