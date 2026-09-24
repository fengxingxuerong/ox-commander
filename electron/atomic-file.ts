/**
 * Atomic file replacement for the main process.
 *
 * Why: `fs.writeFileSync(target, ...)` truncates in place. A crash, a kill or a
 * full disk between truncate and flush leaves a zero-byte or half-written file —
 * for `projects.json` that silently destroys every project record, and for
 * `settings.json` it discards the operator's whole configuration.
 *
 * The fix is the standard write-temp-then-rename dance: rename is atomic within
 * a filesystem, so a reader either sees the complete old file or the complete
 * new one, never a partial write.
 *
 * Not shared with `shared/`: that directory must stay free of `node:fs`.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Writes `content` to `file`, replacing it atomically.
 *
 * The temp file is created in the *same directory* as the target, because
 * `fs.renameSync` is only atomic within one filesystem — `/tmp` is frequently a
 * different mount, which would degrade the rename to a copy.
 */
/**
 * 同一进程内的单调序数。`pid + Date.now()` 两件套的漏洞是**毫秒粒度**：
 * 同一毫秒里连写两次（并发任务各自落盘、或重入写同一个文件）会得到同一个
 * tmp 名，后写的覆盖先写的 —— 那次 write 的内容就凭空丢了，且没有任何报错。
 * 与 `store.ts` 的 `idSeq`、`scheduler.ts` 的 `dispatchSeq` 同一套做法。
 */
let tmpSeq = 0;

/**
 * 临时文件名策略（纯函数，便于断言"同毫秒也不同名"）。
 * 落点是**同目录**：`fs.renameSync` 只在同一文件系统内是原子的，`/tmp`
 * 常是另一个挂载点，跨挂载会退化成复制。
 */
export function tempNameFor(base: string, pid = process.pid, now = Date.now()): string {
  return `.${base}.${pid}.${now}.${(tmpSeq += 1)}.tmp`;
}

export function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Unique per process+call so two concurrent writers cannot clobber each
  // other's temp file; the rename that follows is what actually publishes.
  const tmp = path.join(dir, tempNameFor(path.basename(file)));
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    // Leaving the temp file behind would accumulate, and on Windows a failed
    // rename still holds the handle differently than on POSIX.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort: the original error is the one worth reporting
    }
    throw err;
  }
}

/**
 * Reads and parses a JSON file, returning `fallback` when it is missing.
 *
 * A file that exists but does not parse is **not** silently defaulted: that is
 * how a truncated write previously turned into "all my projects disappeared" with
 * no error anywhere. The JSON parse error propagates so the caller can surface it.
 */
export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(stripBom(raw)) as T;
}

/** Tolerate UTF-8 BOM written by external tools (e.g. PowerShell Set-Content). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
