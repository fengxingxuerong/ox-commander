import fs from "node:fs";
import path from "node:path";
import { isInsideZone } from "./file-journal";

export interface SnapshotScope {
  runId: string;
  root: string;
  zones: string[];
  /** Extra paths (outside the zones) that must be restorable too. */
  include?: string[];
}

export interface SnapshotToken {
  id: string;
  rootAbs: string;
  dirAbs: string;
  zones: string[];
  /** relative posix path → backup was taken (always a real copy). */
  backedUp: Map<string, "copy">;
  /** Files that could not be backed up (over budget / unreadable). */
  skipped: string[];
  truncated: boolean;
}

export interface RevertResult {
  /** Files restored from the backup (they existed before the batch). */
  restored: string[];
  /** Files deleted (they were created by the batch). */
  removed: string[];
  /** Files that could not be restored, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 一个存档批次（B1 第二半）：备份从"跑完即删"变成"留下供 diff 与回滚"。
 * `meta.json` 落盘在存档目录里，`listArchives` 靠它枚举 —— 目录在而
 * meta 不在的存档不可点名，也不该被回滚或 diff 引用。
 */
export interface ArchivedBatch {
  id: string;
  runId: string;
  ts: string;
  rootAbs: string;
  zones: string[];
  /** 有备份的文件相对路径（before 内容的来源；新建文件不在此列）。 */
  files: string[];
}

export interface SnapshotStoreOptions {
  /** Where backups live; one directory per run. */
  backupRoot: string;
  /** Give up backing up beyond this many files (the run is then marked truncated). */
  maxFiles?: number;
  skipDirs?: Set<string>;
}

const DEFAULT_SKIP_DIRS = new Set(["node_modules", ".git", ".ox-quarantine"]);

/**
 * The fs surface this module needs. Injected so tests can exercise the paths a
 * real filesystem cannot produce on every platform — a `readdirSync` that throws
 * EACCES, a dirent that is neither file nor directory, a delete that is refused.
 * Defaults to the real `node:fs`, so production behaviour is unchanged.
 */
export interface SnapshotFsLike {
  existsSync(p: string): boolean;
  statSync(p: string): { isFile(): boolean; isDirectory(): boolean };
  readdirSync(dir: string, opts: { withFileTypes: true }): fs.Dirent[];
  mkdirSync(p: string, opts: { recursive: true }): void;
  copyFileSync(from: string, to: string): void;
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts: { force?: boolean; recursive?: boolean; maxRetries?: number }): void;
}

/**
 * Content backups so a batch can be rolled back.
 *
 * Three rules learned the hard way:
 *
 * 1. **Never `git stash`, never `git checkout -- .`.** Both silently discard the
 *    operator's uncommitted work when `.git` is in a bad state (a documented
 *    failure mode on this machine: `.git/refs` disappeared twice). Backups are
 *    plain files copied out of the tree — this module does not run any process
 *    at all, so git cannot be involved even by accident.
 * 2. **Never hard-link the backups.** A hard link shares the inode, and the
 *    obvious way to modify a file (`fs.writeFileSync(path, …)`) truncates that
 *    inode in place — which silently rewrites the "backup" too. Measured while
 *    writing this: the rollback restored the *new* content. Backups are real
 *    copies.
 * 3. **Only back up what the batch could touch** (its zones), so the cost stays
 *    proportional to the task rather than the repository.
 *
 * Restore semantics: backed-up paths are copied back; a path with no backup is
 * deleted **only** when the caller proves the batch created it (`revert`'s
 * `created`, which comes from `FileJournal` — that one sees the whole tree) or
 * when the no-selection walk covered its location and found nothing there.
 * "No backup" on its own means *unknown*, and unknown is never a reason to
 * delete somebody else's file.
 */
export class SnapshotStore {
  private readonly backupRoot: string;
  private readonly maxFiles: number;
  private readonly skipDirs: Set<string>;
  private readonly fsImpl: SnapshotFsLike;

  constructor(opts: SnapshotStoreOptions, fsImpl: SnapshotFsLike = fs as unknown as SnapshotFsLike) {
    this.backupRoot = path.resolve(opts.backupRoot);
    this.maxFiles = opts.maxFiles ?? 5_000;
    this.skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
    this.fsImpl = fsImpl;
  }

  async begin(scope: SnapshotScope): Promise<SnapshotToken> {
    const rootAbs = path.resolve(scope.root);
    const dirAbs = path.join(this.backupRoot, scope.runId.replace(/[^\w.-]/g, "_"));
    this.fsImpl.mkdirSync(dirAbs, { recursive: true });
    const include = (scope.include ?? []).map(toRel);
    const token: SnapshotToken = {
      id: scope.runId,
      rootAbs,
      dirAbs,
      zones: [...scope.zones],
      backedUp: new Map(),
      skipped: [],
      truncated: false,
    };
    const candidates = this.collect(rootAbs, scope.zones, include);
    for (const rel of candidates) {
      if (token.backedUp.size >= this.maxFiles) {
        token.truncated = true;
        token.skipped.push(rel);
        continue;
      }
      const from = path.join(rootAbs, rel);
      const to = path.join(dirAbs, rel);
      try {
        this.fsImpl.mkdirSync(path.dirname(to), { recursive: true });
        // A real copy: hard links would share the inode, and in-place writes
        // (fs.writeFileSync on the original path) would corrupt the backup.
        this.fsImpl.copyFileSync(from, to);
        token.backedUp.set(rel, "copy");
      } catch {
        token.skipped.push(rel);
      }
    }
    return token;
  }

  /**
   * Rolls the workspace back to the state captured by `begin`.
   * `sel.paths` limits the rollback to specific files (used for zone violations);
   * omitting it rolls back everything the batch touched.
   *
   * `sel.created` is the caller's positive evidence (from `FileJournal`, which
   * sees the whole tree) about which of those paths the batch *made*. A path with
   * no backup and no such evidence is reported, never deleted.
   */
  async revert(
    token: SnapshotToken,
    sel?: { paths?: readonly string[]; created?: readonly string[] },
  ): Promise<RevertResult> {
    const result: RevertResult = { restored: [], removed: [], skipped: [] };
    const created = new Set((sel?.created ?? []).map(toRel));
    const targets = sel?.paths ?? null;

    if (targets) {
      for (const raw of targets) {
        const rel = toRel(raw);
        this.revertOne(token, rel, result, created);
      }
      return result;
    }

    // No selection: restore every backed-up file, and delete anything the batch
    // created that the snapshot does not know about. `newlyCreated` walks exactly
    // the zones this token covered, so "not there" is evidence in its own right.
    for (const rel of token.backedUp.keys()) this.revertOne(token, rel, result, created);
    for (const rel of this.newlyCreated(token)) {
      const abs = path.join(token.rootAbs, rel);
      try {
        this.fsImpl.rmSync(abs, { force: true });
        result.removed.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
    }
    return result;
  }

  /** Drops the backup directory; call after a successful batch. */
  async commit(token: SnapshotToken): Promise<void> {
    try {
      this.fsImpl.rmSync(token.dirAbs, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a stuck backup dir is not worth failing a successful batch over
    }
  }

  // ── 批次存档（竞品缺口 B1 第二半：逐行 diff 与单文件回滚的数据源）───────
  //
  // 旧行为是"批次成功即回收备份"，于是看板上「改了哪些文件」之外再也答不了
  // 「改了什么、能不能只撤这一个」—— diff 没有 before 数据源，回滚没有备份。
  // 存档把成功的批次备份**留下**（移到 archive/ 而非删除），并按容量策略
  // 只保留最近 N 批（`pruneArchives`）。代价是磁盘：上限内的批次数 × 每批
  // zone 内文件数，界面与审计都能点名现存存档，不存在静默增长。

  /** 默认保留多少个批次的存档。 */
  static readonly DEFAULT_MAX_ARCHIVES = 8;

  /** 存档批次 id 的同进程单调序数（防同毫秒撞 id）。 */
  private archiveSeq = 0;

  private get archiveDir(): string {
    return path.join(this.backupRoot, "archive");
  }

  /**
   * 把一次成功批次的备份转成存档。返回存档描述；`token.backedUp` 为空
   * （没有任何可备份的文件）时返回 `null` —— 没有 before 内容的批次
   * （典型是纯新建批）不值得占一个存档位。
   *
   * 失败（跨设备 rename 之类）抛给调用方：BatchGuard 的回退是 commit
   * 回收 + 事件里说一声，保持"没有存档"这条旧路的可观测性。
   */
  async archive(
    token: SnapshotToken,
    meta: { runId: string },
    opts: { maxArchives?: number } = {},
  ): Promise<ArchivedBatch | null> {
    if (token.backedUp.size === 0) {
      // 没有 before 内容的批次（纯新建批）：不占存档位，备份目录也没用了。
      try {
        this.fsImpl.rmSync(token.dirAbs, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // 删不掉的空目录不比一次成功批次更值得失败
      }
      return null;
    }
    const dir = this.archiveDir;
    this.fsImpl.mkdirSync(dir, { recursive: true });
    const batchId = `${meta.runId.replace(/[^\w.-]/g, "_")}__${Date.now().toString(36)}-${(this.archiveSeq += 1)}`;
    const dest = path.join(dir, batchId);
    this.fsImpl.renameSync(token.dirAbs, dest);
    const record: ArchivedBatch = {
      id: batchId,
      runId: meta.runId,
      ts: new Date().toISOString(),
      rootAbs: token.rootAbs,
      zones: [...token.zones],
      files: [...token.backedUp.keys()].sort(),
    };
    fs.writeFileSync(path.join(dest, "meta.json"), JSON.stringify(record, null, 2), "utf8");
    this.pruneArchives(opts.maxArchives);
    return record;
  }

  /** 现存存档（最新在前）。meta.json 读不出来的目录被跳过并说破。 */
  listArchives(): ArchivedBatch[] {
    const dir = this.archiveDir;
    if (!this.fsImpl.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: ArchivedBatch[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, e.name, "meta.json"), "utf8");
        out.push(JSON.parse(raw) as ArchivedBatch);
      } catch {
        // 没有 meta 的存档目录不可枚举（listArchives 的契约是"可点名的"），跳过
      }
    }
    // 新的在前。主键 ts，次键 id 尾部的序号（同毫秒连开几批时 ts 相同，
    // 只按 ts 排序会得到不稳定顺序 —— prune 的"删最旧"必须确定性）。
    return out.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
      return archiveSeqOf(b.id) - archiveSeqOf(a.id);
    });
  }

  /** 存档批次里某文件的 before 内容；没有备份返回 `null`。 */
  readArchived(batchId: string, relPath: string): string | null {
    const file = this.archivedFilePath(batchId, relPath);
    if (file === null) return null;
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /** True when the batch has a readable archive record. */
  hasArchive(batchId: string): boolean {
    const dir = path.join(this.archiveDir, batchId.replace(/[^\w.-]/g, "_"));
    return this.fsImpl.existsSync(path.join(dir, "meta.json"));
  }

  /** True when the archive holds a before-copy of `relPath` (restorable). */
  hasBackupFor(batchId: string, relPath: string): boolean {
    const file = this.archivedFilePath(batchId, relPath);
    return file !== null && this.fsImpl.existsSync(file);
  }

  /**
   * 单文件回滚（B1 第二半的"只撤这一个"）。
   *
   * 与 `revert` 共用同一条纪律：**没有备份时，"它是本批新建"必须有调用方的
   * 正面证据**（`created`，来自 FileJournal 的 create 记录经审计透出）——
   * 没有证据就拒绝删除并说破原因，宁可留一个脏文件也不删错一个既有文件。
   * 有备份时一律从存档复制回工作区（那一刻盘上是新内容，备份是旧内容）。
   */
  async restoreArchived(
    batchId: string,
    relPath: string,
    created: boolean,
  ): Promise<{ ok: true; action: "restored" | "removed" | "already-gone" } | { ok: false; reason: string }> {
    const dir = this.archiveDirFor(batchId);
    if (dir === null) return { ok: false, reason: "存档不存在（可能已被容量策略回收）" };
    const rel = toRel(relPath);
    // 与 readArchived 同一道穿越防护，且绝对路径按**原始输入**判 —— `toRel`
    // 会剥掉前导斜杠（那是它的归一化语义），拿归一化后的串判绝对路径
    // 等于永远判不出。`..` 段查分割后的每一节（"src/../../x.js" 这种
    // 中缀穿越不 startsWith("..")，但 resolve 后的双保险会兜住它）。
    const raw = relPath.replace(/\\/g, "/");
    if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || rel === "" || rel.split("/").includes("..")) {
      return { ok: false, reason: "路径不合法（拒绝绝对路径与上级目录）" };
    }
    const backup = path.join(dir, rel);
    const record = this.readArchiveRecord(batchId);
    if (record === null) return { ok: false, reason: "存档记录读不出来（meta.json 缺失或损坏）" };
    const target = path.join(record.rootAbs, rel);
    // 双保险：解析后的两个路径都必须各归其位。
    if (!path.resolve(backup).startsWith(dir + path.sep)) {
      return { ok: false, reason: "备份路径越出存档目录（拒绝恢复）" };
    }
    if (!path.resolve(target).startsWith(path.resolve(record.rootAbs) + path.sep)) {
      return { ok: false, reason: "目标路径越出工作区（拒绝写入）" };
    }

    if (this.fsImpl.existsSync(backup)) {
      try {
        this.fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        this.fsImpl.copyFileSync(backup, target);
        return { ok: true, action: "restored" };
      } catch (err) {
        return { ok: false, reason: `恢复失败：${(err as Error).message}` };
      }
    }

    if (!created) {
      return { ok: false, reason: "无备份、也没有本批新建的证据：这可能是既有文件，不删" };
    }
    if (!this.fsImpl.existsSync(target)) return { ok: true, action: "already-gone" };
    try {
      this.fsImpl.rmSync(target, { force: true });
      return { ok: true, action: "removed" };
    } catch (err) {
      return { ok: false, reason: `删除失败：${(err as Error).message}` };
    }
  }

  /**
   * 容量策略：超过 `maxArchives` 的存档按时间从旧到新删除。返回被删的 id。
   * 删除失败（文件被占用）只跳过不抛 —— 它是后台卫生，不该让调用方红。
   */
  pruneArchives(maxArchives: number = SnapshotStore.DEFAULT_MAX_ARCHIVES): string[] {
    const archives = this.listArchives(); // 最新在前
    if (archives.length <= maxArchives) return [];
    const dropped: string[] = [];
    for (const old of archives.slice(maxArchives)) {
      try {
        this.fsImpl.rmSync(path.join(this.archiveDir, old.id), { recursive: true, force: true, maxRetries: 3 });
        dropped.push(old.id);
      } catch {
        // 占用的存档留在盘上，下次 prune 再试；此刻不失败
      }
    }
    return dropped;
  }

  /** 存档批次目录；batchId 非法（穿越字符）时返回 null。 */
  private archiveDirFor(batchId: string): string | null {
    if (typeof batchId !== "string") return null;
    const safe = batchId.replace(/[^\w.-]/g, "_");
    const dir = path.join(this.archiveDir, safe);
    // 双保险：规范化后仍须在 archive/ 之下（replace 已经剥掉分隔符，
    // 这一句防的是未来有人改宽上面那个字符类）。
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(this.archiveDir) + path.sep)) return null;
    return this.fsImpl.existsSync(resolved) ? resolved : null;
  }

  /** 备份文件的绝对路径；batchId 或 relPath 非法（穿越）时返回 null。 */
  private archivedFilePath(batchId: string, relPath: string): string | null {
    const dir = this.archiveDirFor(batchId);
    if (dir === null) return null;
    const rel = toRel(relPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const file = path.resolve(path.join(dir, rel));
    if (!file.startsWith(dir + path.sep)) return null;
    return file;
  }

  private readArchiveRecord(batchId: string): ArchivedBatch | null {
    const dir = this.archiveDirFor(batchId);
    if (dir === null) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as ArchivedBatch;
    } catch {
      return null;
    }
  }

  /** True when the path has a restorable backup. */
  hasBackup(token: SnapshotToken, relPath: string): boolean {
    return token.backedUp.has(toRel(relPath));
  }

  private revertOne(
    token: SnapshotToken,
    rel: string,
    result: RevertResult,
    created: ReadonlySet<string>,
  ): void {
    const abs = path.join(token.rootAbs, rel);
    const backup = path.join(token.dirAbs, rel);
    if (token.backedUp.has(rel)) {
      try {
        this.fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
        this.fsImpl.copyFileSync(backup, abs);
        result.restored.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
      return;
    }
    if (!this.fsImpl.existsSync(abs)) {
      result.skipped.push({ path: rel, reason: "快照中没有该文件，且当前不存在（无需回滚）" });
      return;
    }
    /*
     * 无备份时，"它是本批新建"必须有正面证据，不能靠"我扫过那里没有"推断 ——
     * 快照只覆盖本批的 zone，而根级 package.json / lockfile 常在 zone 外：
     * 它们被模型改过之后，旧逻辑认定"备份里没有 ⇒ 新建 ⇒ 删掉"，于是用户项目
     * 的清单文件被删（默认 revert-batch 档下每轮重修再删一次）。
     */
    if (!created.has(rel)) {
      result.skipped.push({ path: rel, reason: "无备份、也无本批新建的证据：保留现状不删，需人工确认" });
      return;
    }
    // 这里不再另设"备份时被跳过"的分支：一个路径能进 `skipped` 就意味着 begin()
    // 时它存在，那日志只会记 modify 而不会记 create，上面那一步已经把它拦住了。
    // 多写一层不会更错，只会多一个谁也验证不了的位点（site 口径下当场存活）。
    try {
      this.fsImpl.rmSync(abs, { force: true });
      result.removed.push(rel);
    } catch (err) {
      result.skipped.push({ path: rel, reason: (err as Error).message });
    }
  }

  private newlyCreated(token: SnapshotToken): string[] {
    const out: string[] = [];
    // A file the snapshot skipped (over budget) may well have existed before the
    // batch — deleting it would be destructive, so it is never treated as new.
    const skipped = new Set(token.skipped.map(toRel));
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = toRel(path.relative(token.rootAbs, abs));
        if (!token.backedUp.has(rel) && !skipped.has(rel)) out.push(rel);
      }
    };
    // Only paths the batch could have touched: inside the zones. Widening this
    // to the whole tree would delete pre-existing files outside the scope.
    for (const zone of token.zones) {
      // 这里原先有个三目：zone 为 "." 或空串时取空串，否则取 zone 本身。其实
      // path.join 自己就会把 "." 与空串归一化到根，两个分支结果完全相同 ——
      // 删掉它而不是留着：它看着承重，实际没有任何可观测效果。
      // （注释里刻意不写会命中变异算子的运算符字面量：那些算子是 replaceAll，
      // 会连注释一起改写，制造"只改注释不改行为"的假存活。）
      const dirAbs = path.join(token.rootAbs, zone);
      if (this.fsImpl.existsSync(dirAbs)) walk(dirAbs);
    }
    return out;
  }

  private collect(rootAbs: string, zones: readonly string[], include: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = toRel(path.relative(rootAbs, abs));
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
      }
    };
    for (const zone of zones) {
      // Same as above: `path.join` normalises "." and "" to the root by itself.
      const dirAbs = path.join(rootAbs, zone);
      if (!this.fsImpl.existsSync(dirAbs)) continue;
      const stat = this.fsImpl.statSync(dirAbs);
      if (stat.isFile()) {
        const rel = toRel(path.relative(rootAbs, dirAbs));
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push(rel);
        }
        continue;
      }
      walk(dirAbs);
    }
    for (const extra of include) {
      const rel = toRel(extra);
      if (seen.has(rel)) continue;
      if (!this.fsImpl.existsSync(path.join(rootAbs, rel))) continue;
      seen.add(rel);
      out.push(rel);
    }
    return out;
  }
}

function toRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 存档 id 尾部的同进程序号（`…-<seq>`）；解析不出给 0。
 *
 * 写法刻意用 `??` 而不是三目：`archive()` 生成的 id 恒以 `-<seq>` 结尾
 * （runId 已过 `[^\w.-]` 过滤，seq 是递增整数），所以"匹配不到"这一支在
 * 正常数据下不可达 —— 三目的两支只有一支活，等于给变异门禁留一个永远
 * 杀不掉的位点。`??` 保留同一兜底（被篡改/旧版本的 meta.json 不给 NaN），
 * 且不产生三目位点。（同 `sort` 比较器那条纪律：死分支该简化源码。）
 */
function archiveSeqOf(batchId: string): number {
  return Number(/-(\d+)$/.exec(batchId)?.[1] ?? 0);
}

/** True when the zone predicates say the file belongs to the batch. */
export function withinZones(rel: string, zones: readonly string[]): boolean {
  return zones.some((z) => isInsideZone(rel, z));
}
