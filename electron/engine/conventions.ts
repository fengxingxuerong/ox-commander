/**
 * 读项目根的约定文件（B3）：`OX.md` / `AGENTS.md`。
 *
 * 纯读盘、零判断：内容怎么拼、多长算超限都归
 * `shared/project-conventions.ts` 的 `formatConventionsBlock` —— 那一层是纯函数，
 * 双端（桌面 / headless）共用同一套口径。这里只负责"读得到就读，读不到当没有"。
 *
 * 为什么读失败不抛：约定是背景，不是交付条件。一个权限不对的 AGENTS.md
 * 不该让整个 run 起不来 —— 缺席与读不到在语义上是同一件事（没有约定可用），
 * 但后者值得在日志里说一声（调用方拿 `name` 判断即可，这里不吞日志）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  CONVENTION_FILE_NAMES,
  type ConventionFile,
} from "../../shared/project-conventions";
import { PLAN_MEMO_FILE_NAME } from "../../shared/plan-memo";

/** 单个约定文件的读取上限：超过就不读（避免把几百 MB 的笔记塞进提示）。 */
const MAX_SINGLE_FILE_BYTES = 256 * 1024;

export interface ReadConventionsResult {
  /** 读到的文件（按 `CONVENTION_FILE_NAMES` 顺序，只含非空内容的）。 */
  files: ConventionFile[];
  /** 存在但读失败的文件（含原因）—— 报给日志用，不阻塞。 */
  unreadable: Array<{ name: string; reason: string }>;
  /** 存在但超过单文件上限而跳过的文件。 */
  skipped: Array<{ name: string; bytes: number }>;
}

export interface ConventionSource {
  /** 写进提示块的小节名（如 `~/.ox/AGENTS.md`）。 */
  name: string;
  /** 绝对路径。 */
  abs: string;
}

/**
 * 读约定文件。默认只读项目根的 `OX.md` / `AGENTS.md`；`extra` 用来在它们
 * **之前**插入全局约定（chat 的 `~/.ox/AGENTS.md`），顺序是"个人偏好 →
 * 项目约定"，与 Codex 的合并方向一致。
 */
export function readProjectConventions(
  rootAbs: string,
  extra: readonly ConventionSource[] = [],
): ReadConventionsResult {
  const out: ReadConventionsResult = { files: [], unreadable: [], skipped: [] };
  const sources: ConventionSource[] = [
    ...extra,
    ...CONVENTION_FILE_NAMES.map((name) => ({ name, abs: path.join(rootAbs, name) })),
  ];
  for (const { name, abs } of sources) {
    let bytes: number;
    try {
      bytes = fs.statSync(abs).size;
    } catch {
      continue; // 不存在 = 常态
    }
    if (bytes > MAX_SINGLE_FILE_BYTES) {
      out.skipped.push({ name, bytes });
      continue;
    }
    try {
      out.files.push({ name, content: fs.readFileSync(abs, "utf8") });
    } catch (err) {
      out.unreadable.push({ name, reason: (err as Error).message });
    }
  }
  return out;
}

/** 规划备忘的读取结果。与约定同形：缺席是常态、读不动不阻塞。 */
export interface ReadPlanMemoResult {
  /** 文件正文；缺席或空文件时为 `undefined`（调用方据此不产块）。 */
  content?: string;
  /** 读不动的原因（存在但读失败）。 */
  unreadable?: string;
  /** 超过单文件上限时的字节数。 */
  skippedBytes?: number;
}

/**
 * 读项目根的规划备忘（`OX-PLAN.md`，2026-10-25）。
 *
 * 与 `readProjectConventions` 同一套失败语义：**缺席是常态**、读不动不抛。
 * 分开成两个函数而不是一个通用读取器：备忘是**单文件**，没有"多文件拼接顺序"
 * 这件事，硬塞进通用形状只会多一个没人验证的分支。
 */
export function readPlanMemo(rootAbs: string): ReadPlanMemoResult {
  const abs = path.join(rootAbs, PLAN_MEMO_FILE_NAME);
  let bytes: number;
  try {
    bytes = fs.statSync(abs).size;
  } catch {
    return {}; // 不存在 = 常态
  }
  if (bytes > MAX_SINGLE_FILE_BYTES) return { skippedBytes: bytes };
  try {
    return { content: fs.readFileSync(abs, "utf8") };
  } catch (err) {
    return { unreadable: (err as Error).message };
  }
}
