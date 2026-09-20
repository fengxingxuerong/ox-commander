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
export function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Unique per process+call so two concurrent writers cannot clobber each
  // other's temp file; the rename that follows is what actually publishes.
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
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
