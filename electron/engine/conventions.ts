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

export function readProjectConventions(rootAbs: string): ReadConventionsResult {
  const out: ReadConventionsResult = { files: [], unreadable: [], skipped: [] };
  for (const name of CONVENTION_FILE_NAMES) {
    const abs = path.join(rootAbs, name);
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
