/**
 * 变异门禁「强杀残留自愈」的门卫用例。
 *
 * 为什么单独测它：`verify` 里唯一能还原活体变异体的代码是 `recoverPendingRecord()`，
 * 而它此前**没有任何测试**——2026-09-28 一次被强杀的 site 审计把
 * `orchestrator.ts:575` 的 `=== "skip"` 留在了源码里，下一轮门禁于是死在第 9 段
 * `npm test`（V8 堆 4.6GB → OOM 且不退出），完全不像"工作区脏"。自愈现在被提到
 * 第 1 段 `check:residue`，所以它的结论必须各自钉住：
 *   - 干净 / 台账冗余但内容一致 → 退出 0
 *   - 真的还原了一个变异体      → 退出 2（逼人重跑，不给脏 PASS）
 *   - 台账不可用                → 退出 2，且**不许**说工作区干净
 *   - 台账丢了而备份还在        → 逐份向备份要证据：与源码一致才算干净（2026-10-09 补）
 *
 * 最后一条是补上的盲区：旧实现只看 `index.json`，台账不在就直接宣布"工作区干净"，
 * 手工清台账、`clearPendingRecord` 的删除被杀软挡住、或并发两轮互相清台账时，
 * 活体变异体就带着一个"干净"的结论进到 `npm test`（V8 堆 4.6GB → OOM 且不退出）。
 *
 * 2026-10-11：台账从单槽 `index.json` 改成**按文件一条**（`<备份名>.json`）——
 * 并行 worker（--jobs 按目标分进程）各写各的记录，谁也顶不掉谁；跨会话的
 * 活体残留判定也从"全场互斥"收窄到"本轮要动的文件"。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");

/** 真实台账目录：本文件**只读**它（那条前置卫生用例要看真实工作区有没有活体变异体）。 */
const REAL_PENDING_DIR = path.join(REPO, "scripts", ".mutation-pending");
const REAL_SCRIPT = path.join(REPO, "scripts", "mutation-check.mjs");

/**
 * 用例的现场放在一个**与仓库同形的临时根**上：
 * `<ROOT>/scripts/mutation-check.mjs`（每次用前从真实脚本重新拷一份）+
 * `<ROOT>/scripts/.mutation-pending/` + `<ROOT>/target.ts`。
 *
 * 为什么非要同形：备份名编码的是**相对仓库根的路径**（`pendingBackupName`），孤儿处置靠它
 * 映射回源文件。同形布局下这些语义与真实仓库逐字节一致 —— `target.ts` 编出来就是
 * `target.ts.orig`，那条 `scripts__.mutation-pending__armed.ts.orig` 的字面断言也不需要
 * 长出第二份编码实现。
 *
 * 为什么必须搬出真实目录（2026-10-13 实测）：这些用例原本直接往 `scripts/.mutation-pending/`
 * 造现场，正常收尾靠 afterEach 把整目录删掉。一旦 `npm test` 被中途打断，现场就留在**门禁
 * 脚本自己扫描的那个目录**里：
 *   - 留一枚映射不回的 `.orig` ⇒ `check:residue`（verify 链首）退出 2 并要人工 rm；
 *   - 「备份写不下去时退出 2」那条更狠，它把一个**普通文件**放在台账目录位上 ⇒ 链首读目录时
 *     ENOTDIR 崩。
 * 也就是说：用来防残留的那套用例，自己就是链首被锁死的来源。现场挪到 OS 临时目录后，
 * 最坏的泄漏落在仓库外面，一次打断不再能锁死唯一验收入口。
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ox-residue-root-"));
const SCRIPT = path.join(ROOT, "scripts", "mutation-check.mjs");
const PENDING_DIR = path.join(ROOT, "scripts", ".mutation-pending");
fs.mkdirSync(PENDING_DIR, { recursive: true });

/** 每次用之前把真实判据脚本按字节拷进同形根：判据改了立刻可见，不留陈旧副本。 */
function syncGate(): void {
  fs.copyFileSync(REAL_SCRIPT, SCRIPT);
}
// 采集期就有用例体外的 `readFileSync(SCRIPT)`（锚点常量），所以先拷一次。
syncGate();

/** 一次运行的结果，测试只看这三样。 */
interface RecoverRun {
  status: number | null;
  out: string;
  err: string;
}

const scratch: string[] = [];

/** 目标文件放在 pending 目录**之外**：还原后内容必须仍然可观察。
 *  放在同形根下（而不是 OS 临时目录）是为了让备份名按真实编码规则映射得回来。 */
function makeTarget(original: string, current: string): string {
  const file = path.join(ROOT, "target.ts");
  fs.writeFileSync(file, current, "utf8");
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const backup = path.join(PENDING_DIR, "target.ts.orig");
  fs.writeFileSync(backup, original, "utf8");
  return file;
}

/**
 * 备份文件名的编码规则归门禁脚本自己定，测试不复制第二份实现 ——
 * 按锚点把 `pendingBackupName` / `armPendingRecord` 从脚本里抠出来直接调
 * （手法与下面 `restoreSource` 那一节一致，锚点不在了会当场说清）。
 */
function loadPending(
  processImpl: { exit: (code: number) => void },
  fsImpl: {
    mkdirSync: typeof fs.mkdirSync;
    writeFileSync: typeof fs.writeFileSync;
    readFileSync: typeof fs.readFileSync;
  } = fs,
): {
  pendingBackupName: (file: string) => string;
  armPendingRecord: (file: string, original: string) => void;
} {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("/** 备份文件名");
  const end = src.indexOf("/** 同步等待（毫秒）");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("无法在 mutation-check.mjs 里定位备份台账区（锚点被改名或移动了？）");
  }
  const factory = new Function(
    "fs",
    "path",
    "ROOT",
    "PENDING_DIR",
    "process",
    "relFromRoot",
    `${src.slice(start, end)}\nreturn { pendingBackupName, armPendingRecord };`,
  );
  return factory(
    fsImpl,
    path,
    ROOT,
    PENDING_DIR,
    processImpl,
    (p: string) => path.relative(ROOT, p).split(path.sep).join("/"),
  ) as {
    pendingBackupName: (file: string) => string;
    armPendingRecord: (file: string, original: string) => void;
  };
}

/** 某个目标文件的台账记录路径。目标现在落在同形根下，所以
 *  `pendingBackupName(path.join(ROOT,"target.ts"))` 算出来就是 `target.ts.orig`，
 *  这两个固定名**等于**编码规则的输出，不是绕过它（`armed.ts` 那条用例仍然直接拿门禁自己的
 *  `pendingBackupName` 断言一次，防的就是这里哪天与规则分叉）。 */
const RECORD = path.join(PENDING_DIR, "target.ts.orig.json");
const OTHER_RECORD = path.join(PENDING_DIR, "other.ts.orig.json");

/** 给指定路径写一条台账（损坏内容走 string）。记录路径由用例自己给：
 *  recover 是扫描 *.json 不重算路径；arm/clear 的编码一致性由各自的用例钉住。 */
function writeRecord(recordPath: string, record: unknown): void {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(
    recordPath,
    typeof record === "string" ? record : JSON.stringify(record),
    "utf8",
  );
}

/**
 * 台账已丢（没有任何记录文件）而备份仍在的现场。
 * 源文件放在 pending 目录**里面**：那里 git 已忽略，又能被备份名映射回来。
 */
function makeOrphan(original: string, current: string): { file: string; backup: string } {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const name = `orphan-${process.pid}-${Date.now().toString(36)}.ts`;
  const file = path.join(PENDING_DIR, name);
  fs.writeFileSync(file, current, "utf8");
  const backup = path.join(PENDING_DIR, loadPending({ exit: () => undefined }).pendingBackupName(file));
  fs.writeFileSync(backup, original, "utf8");
  return { file, backup };
}

/**
 * 跑一次 `--recover-only`。
 *
 * ⚠️ **`status` 为 null 不等于"它退出了某个码"**：那是**子进程根本没起来**
 * （`spawnSync` 的 `error` 才有原因）。2026-10-11 在一台受管 Windows 上实测到
 * `spawnSync EBUSY` —— 该环境阻断子进程的 stdio 管道，直接执行同一个 node.exe
 * 却正常。那种情况下每条断言都只看到 `expected null to be 2`，排查者会误以为
 * 是判据脚本的退出码逻辑坏了，而真相在环境那一层。
 *
 * 所以 spawn 失败在这里**当场说破并带上 error**，不让它伪装成一个退出码。
 */
function recoverOnly(): RecoverRun {
  const r = spawnSync(process.execPath, [SCRIPT, "--recover-only"], { encoding: "utf8" });
  if (r.error) {
    throw new Error(
      `无法 spawn 子进程跑判据脚本（status=null 表示它没起来，不是它退了码）：` +
        `${r.error.message}。若 error 是 EBUSY/EPIPE 一类，先查宿主是否阻断了子进程的 stdio 管道。`,
    );
  }
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 真实台账目录在每个用例开始时的内容快照 —— 本文件一个字节都不许往那里写。 */
let realDirBefore: string[] = [];

beforeEach(() => {
  syncGate();
  realDirBefore = fs.existsSync(REAL_PENDING_DIR) ? fs.readdirSync(REAL_PENDING_DIR) : [];
});

afterEach(() => {
  // 类守卫（2026-10-13）：现场在同形临时根里造，真实台账目录若在本用例期间多出任何一项，
  // 就是有人把 fixture 又写回了门禁自己扫描的那个目录 —— 一次被打断的 `npm test` 于是
  // 留下一枚映射不回的备份，`check:residue`（verify 链首）从此退出 2 并要求人工 rm。
  // 判据不放宽：并发跑着另一轮真变异时它写的台账名映射得回源文件，请先等它收工再复跑本文件。
  const now = fs.existsSync(REAL_PENDING_DIR) ? fs.readdirSync(REAL_PENDING_DIR) : [];
  const added = now.filter((n) => !realDirBefore.includes(n));
  if (added.length > 0) {
    throw new Error(
      `本用例往真实台账目录 scripts/.mutation-pending/ 落了东西：${added.join(", ")}。` +
        "fixture 只许落在同形临时根里 —— 留在这里而映射不回源文件的备份，" +
        "会让 verify 链首（check:residue）退出 2 并要求人工删除。",
    );
  }
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// 同形根是整个文件共用一个（备份名的编码规则要它稳定），所以在这里一次删掉：
// 正常收尾不留 OS 临时目录，被中途打断时留下的也只是仓库外的垃圾。
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/**
 * 前置卫生检查：源码里现在有没有**活体变异体**。
 *
 * 判据的权威实现是 `check:residue`（verify 第 1 段），这里不复用它 —— 它会**写盘**：
 * 并发跑第二轮变异时，本用例若去调它，会把那一轮还活着的台账连根清掉，
 * 反而把别人的残留变成无主的（正是下面「孤儿备份」要处置的形态）。
 *
 * 也不用"台账文件在不在"当代理指标：2026-10-09 实测到一次假红 —— 另一轮变异跑到
 * 两次改写的间隙（源码已还原、台账还在），旧断言必红，而那时并不会 OOM。
 * OOM 的直接原因是活体变异体，所以就看它。台账按文件一条后这里逐条扫。
 */
function liveMutant(): string | null {
  if (!fs.existsSync(REAL_PENDING_DIR)) return null;
  const records = fs.readdirSync(REAL_PENDING_DIR).filter((n) => n.endsWith(".json"));
  for (const name of records) {
    // ⚠️ 必须是 REAL_PENDING_DIR：上面 readdir 读的是真实台账目录，这里若用测试的
    // PENDING_DIR（由环境变量注入给被测脚本），join 出来的是临时目录里不存在的路径，
    // readFileSync 抛 ENOENT 被 catch 成"台账不可读" —— 只要真实台账非空就恒红。
    const record = path.join(REAL_PENDING_DIR, name);
    let rec: { file?: string; backup?: string };
    try {
      rec = JSON.parse(fs.readFileSync(record, "utf8")) as { file?: string; backup?: string };
    } catch {
      return "台账不可读";
    }
    if (!rec.file || !rec.backup || !fs.existsSync(rec.backup)) return "台账指向的文件或备份缺失";
    if (fs.readFileSync(rec.file, "utf8") !== fs.readFileSync(rec.backup, "utf8")) return rec.file;
  }
  return null;
}

describe("mutation-check --recover-only（verify 第 1 段）", () => {
  it("starts with no live mutant on disk — that is what balloons vitest to 4.6GB", () => {
    // 这条不只是卫生检查：它把「带残留跑测试」变成一次点名失败，而不是 OOM。
    expect(liveMutant(), "工作区有未还原的变异体，跑 npm run check:residue 还原后再跑测试").toBeNull();
  });

  it("exits 0 and says clean when there is no pending record at all", () => {
    const run = recoverOnly();
    expect(run.status).toBe(0);
    expect(run.out).toContain("无变异残留");
  });

  it("restores the mutated file, clears the record, and exits 2 so nobody reads a dirty PASS", () => {
    const file = makeTarget('if (decision === "skip") {\n', 'if (decision !== "skip") {\n');
    writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig") });

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe('if (decision === "skip") {\n');
    expect(run.err).toContain("已自动还原");
    expect(fs.existsSync(path.join(PENDING_DIR, "gone.ts.orig.json"))).toBe(false);
  });

  it("treats a stale record whose content already matches the backup as clean", () => {
    const file = makeTarget("same content\n", "same content\n");
    writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig") });

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(run.out).toContain("台账已清理");
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it("refuses to start while another run is live — its ledger is not residue", () => {
    // `PENDING_DIR` 是仓库级全局路径：本机同时开两个会话跑门禁时，旧实现会把别人活着的
    // 台账连备份一起 `rm -rf`，那一轮被强杀后残留就彻底没人认得。
    // 这里起一个**命令行里带着 mutation-check.mjs 的真活进程**（node 只 sleep，不执行脚本）
    // 当那个"另一轮"：判据是 pid 活着 **且** 身份对得上，不是裸 pid 探活。
    // check:residue 是全场卫生检查（myFiles=all），任何文件的活体台账都拦。
    const file = makeTarget("original\n", "MUTANT");
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)", "mutation-check.mjs"], {
      stdio: "ignore",
    });
    try {
      writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig"), pid: live.pid });

      const run = recoverOnly();

      expect(run.status).toBe(2);
      expect(run.err).toContain("另一轮变异正在运行");
      // 现场一点不许动：文件、备份、台账都得留给那一轮自己收
      expect(fs.readFileSync(file, "utf8")).toBe("MUTANT");
      expect(fs.existsSync(path.join(PENDING_DIR, "target.ts.orig"))).toBe(true);
      expect(fs.existsSync(RECORD)).toBe(true);
    } finally {
      live.kill();
    }
  });

  it("does not treat a reused pid as a live run", () => {
    // 2026-10-15 生产事故：凌晨一轮变异被强杀，台账里的 pid 35512 后来被微信
    // （Weixin.exe）复用 —— `isPidAlive` 说它活着，check:residue 于是把一堆早已
    // 还原干净的残留判成"另一轮正在运行"，拒绝清理也拒绝启动，npm test 跟着红。
    // 判据收紧为"pid 活着 **且** 命令行里真是这个脚本"。这里用测试进程自己当那个
    // 被复用的 pid：它确实活着，但命令行里没有 mutation-check。
    const file = makeTarget("already restored\n", "already restored\n");
    writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig"), pid: process.pid });

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(run.out).toContain("台账已清理");
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it("still heals a ledger whose pid is not a live process", () => {
    // 与上一条只差 pid：无效 pid ⇒ 上一轮已经死了，还原照旧。
    const file = makeTarget('if (decision === "skip") {\n', 'if (decision !== "skip") {\n');
    writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig"), pid: -1 });

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("已自动还原");
    expect(fs.readFileSync(file, "utf8")).toBe('if (decision === "skip") {\n');
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it("refuses to call the workspace clean when the record is unreadable", () => {
    const file = makeTarget("original\n", "MUTANT");
    writeRecord(RECORD, "{ this is not json");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("不可用");
    expect(run.out).not.toContain("无变异残留");
    // 没有还原手段时它必须只说"去自查"，而不是悄悄把目标文件当好的。
    expect(fs.readFileSync(file, "utf8")).toBe("MUTANT");
  });

  it("refuses to call the workspace clean when the backup file is gone", () => {
    const file = makeTarget("original\n", "MUTANT");
    writeRecord(RECORD, { file, backup: path.join(PENDING_DIR, "target.ts.orig") });
    fs.rmSync(path.join(PENDING_DIR, "target.ts.orig"));

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.out).not.toContain("无变异残留");
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it("leaves the target file untouched on the clean path", () => {
    // 备份与源文件一致 ⇒ 上一轮其实还原成功了，只是台账没来得及清 —— 这仍然算干净。
    const { file, backup } = makeOrphan("original\n", "original\n");

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
    expect(fs.existsSync(backup)).toBe(false);
  });

  it("refuses to call the workspace clean when a ledger-less backup disagrees with its source", () => {
    // 这条钉住的是台账制的盲区：台账没了而活体变异体还在源码里时，
    // 旧实现只会说"工作区干净"（2026-10-09 实弹：塞一份孤儿备份，退出码 0）。
    const { file } = makeOrphan("if (a === b) {\n", "if (a !== b) {\n");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("无法证明干净");
    expect(run.out).not.toContain("无变异残留");
    // 只许点名、不许动手：孤儿备份可能是写盘写坏的一半，拿它覆盖源码会把好文件截断。
    expect(fs.readFileSync(file, "utf8")).toBe("if (a !== b) {\n");
  });

  it("refuses to call the workspace clean when a stray backup maps to no file", () => {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, "gone-dir__vanished.ts.orig"), "whatever\n", "utf8");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("映射不回源文件");
  });
});

/**
 * pid 身份判定的单元层：`isForeignMutationRun` 的分支 + `pidCommandLine` 的退化链。
 *
 * 为什么值得单测（2026-10-15 生产事故）：判据原来只看 `isPidAlive`，而 pid 会被
 * 别的程序复用（微信）—— 症状是"一堆早已还原干净的残留被判成另一轮正在运行"。
 * 身份校验修好后，**真并发现场**只能覆盖"命令行里确实有 mutation-check"这一条；
 * 退化链（wmic → powershell → 拿不到）与"查不到时保守按活着算"这三条，只有注进去
 * 直接问才问得到。它们恰是最容易在下次重构里被悄悄改坏的部分。
 *
 * 手法与本文件其它节一致：按锚点把函数体从门禁脚本里抠出来注进新作用域，不留第二份
 * 实现；只把 `process` / `spawnSync` / `fs` 换成用例能决定的假件（探活的抛错码
 * 决定不了，所以 `kill` 也换）。
 */
describe("isForeignMutationRun · pid 活着之外还要看身份", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  const START_ANCHOR = "/** 进程号是否还活着";
  const END_ANCHOR = "/** 一条台账的落盘路径";
  const start = SRC.indexOf(START_ANCHOR);
  const end = SRC.indexOf(END_ANCHOR);

  interface Identity {
    isForeignMutationRun: (pid: number) => boolean;
    pidCommandLine: (pid: number) => string | null;
    isPidAlive: (pid: number) => boolean;
  }
  interface SpawnCall {
    cmd: string;
    args: string[];
  }

  /**
   * 抠出 isPidAlive / pidCommandLine / isForeignMutationRun 注进新作用域。
   * `replies` 按调用顺序应答 spawnSync（抛 Error 等价于"这条命令起不来"）；
   * `proc` 决定 posix 侧 `/proc/<pid>/cmdline` 读到什么（默认读不到）。
   */
  function load(opts: {
    platform: string;
    kill?: (pid: number, signal: number) => void;
    replies?: Array<{ status: number; stdout: string } | Error>;
    proc?: (p: string) => string;
  }): { api: Identity; calls: SpawnCall[] } {
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(
        `无法在 mutation-check.mjs 里定位 pid 身份判定区（锚点 ${START_ANCHOR} / ${END_ANCHOR} 被改名或移动了？）`,
      );
    }
    const calls: SpawnCall[] = [];
    const queue = [...(opts.replies ?? [])];
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const processStub = { platform: opts.platform, kill: opts.kill ?? (() => undefined) };
    const spawnSyncStub = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const next = queue.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("队列里没有应答");
      return next;
    };
    const fsStub = {
      readFileSync: (p: fs.PathLike) => {
        if (!String(p).startsWith("/proc/") || !opts.proc) throw enoent();
        return opts.proc(String(p));
      },
    };
    const factory = new Function(
      "fs",
      "process",
      "spawnSync",
      `${SRC.slice(start, end)}\nreturn { isForeignMutationRun, pidCommandLine, isPidAlive };`,
    );
    const api = factory(fsStub, processStub, spawnSyncStub) as unknown as Identity;
    return { api, calls };
  }

  it("pid 已经不存在 ⇒ 不是外来轮次，且不必再去问命令行", () => {
    const { api, calls } = load({
      platform: "win32",
      kill: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(api.isForeignMutationRun(35512)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pid 活着但命令行是别的程序（pid 被复用）⇒ 不是外来轮次", () => {
    // 2026-10-15 事故的最小复现：pid 35512 被 Weixin.exe 复用。
    const { api, calls } = load({
      platform: "win32",
      replies: [{ status: 0, stdout: "C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe" }],
    });

    expect(api.isForeignMutationRun(35512)).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["wmic"]);
  });

  it("pid 活着且命令行正是这个脚本 ⇒ 是外来轮次", () => {
    const { api } = load({
      platform: "win32",
      replies: [
        { status: 0, stdout: "node  D:\\ox\\ox-commander\\scripts\\mutation-check.mjs --mode=site --file=src/store.ts\r\n" },
      ],
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
  });

  it("win32：wmic 没给出有效输出时退化到 PowerShell CIM，且带上那个 pid", () => {
    const { api, calls } = load({
      platform: "win32",
      replies: [
        { status: 0, stdout: "  \r\n" }, // 有进程、命令行空白 ⇒ 等价于拿不到
        { status: 0, stdout: "node  scripts\\mutation-check.mjs" },
      ],
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["wmic", "powershell"]);
    // 过滤器必须点到被问的那个 pid：写成查全表会把别的进程也拖进判定。
    expect(calls[1].args.join(" ")).toContain("ProcessId=4242");
    expect(calls[1].args.join(" ")).toContain("Get-CimInstance Win32_Process");
  });

  it("两条查询都拿不到命令行时，保守按「活着算」", () => {
    // 把不确定当已退出会更糟：那等于让一次查询失败就授权去还原别人正在写的源码。
    const { api, calls } = load({
      platform: "win32",
      replies: [new Error("wmic 已不在"), { status: 1, stdout: "" }],
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["wmic", "powershell"]);
  });

  it("探活返回 EPERM（进程属于别人）也算活着，接保守判定", () => {
    const { api } = load({
      platform: "win32",
      kill: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
      replies: [],
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
  });

  it("posix：/proc/<pid>/cmdline 里正是这个脚本 ⇒ 是外来轮次", () => {
    const { api } = load({
      platform: "linux",
      proc: () => "node\u0000scripts/mutation-check.mjs\u0000--mode=site\u0000",
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
  });

  it("posix：/proc/<pid>/cmdline 是别的程序 ⇒ 不是外来轮次", () => {
    const { api } = load({ platform: "linux", proc: () => "/usr/bin/wechat\u0000--session\u0000" });

    expect(api.isForeignMutationRun(4242)).toBe(false);
  });

  it("posix：/proc 读不到（已退出或无权）时同样保守按活着算", () => {
    const { api } = load({
      platform: "linux",
      proc: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    expect(api.isForeignMutationRun(4242)).toBe(true);
  });

  it("isPidAlive 只认正整数 pid（0/-1/NaN 一律当已退出）", () => {
    const { api } = load({ platform: "win32" });

    expect(api.isPidAlive(0)).toBe(false);
    expect(api.isPidAlive(-1)).toBe(false);
    expect(api.isPidAlive(Number.NaN)).toBe(false);
  });
});

describe("armPendingRecord · 没有落盘台账就不改写源码", () => {
  it("备份名映射得回源文件，台账指向那份备份", () => {
    const { pendingBackupName, armPendingRecord } = loadPending({ exit: () => undefined });
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const file = path.join(PENDING_DIR, "armed.ts");
    fs.writeFileSync(file, "MUTANT\n", "utf8");

    armPendingRecord(file, "ORIGINAL\n");

    const record = path.join(PENDING_DIR, `${pendingBackupName(file)}.json`);
    const rec = JSON.parse(fs.readFileSync(record, "utf8")) as { file: string; backup: string };
    expect(fs.readFileSync(rec.backup, "utf8")).toBe("ORIGINAL\n");
    // 名字里带路径：不同目录的同名文件不会顶掉同一份备份，台账丢了也还能反查源文件。
    expect(path.basename(rec.backup)).toBe("scripts__.mutation-pending__armed.ts.orig");
    // 台账按文件一条：备份名 + .json —— 并行 worker 各写各的，谁也顶不掉谁。
    expect(record.endsWith(".json")).toBe(true);
    expect(rec.file).toBe(file);
  });

  it("备份写不下去时退出 2，而不是警告一声继续跑", () => {
    // 旧实现是"警告后继续"，而那正是盲区的来源 —— 没有台账的残留，`check:residue` 看不见。
    fs.rmSync(PENDING_DIR, { recursive: true, force: true });
    // 父目录位上放一个普通文件：`mkdirSync` 在各平台都确定性抛。
    fs.writeFileSync(PENDING_DIR, "not a directory\n", "utf8");

    const codes: number[] = [];
    const messages: string[] = [];
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    try {
      loadPending({ exit: (code: number) => void codes.push(code) }).armPendingRecord(
        path.join(PENDING_DIR, "armed.ts"),
        "ORIGINAL\n",
      );
    } finally {
      console.error = realError;
    }

    expect(codes).toEqual([2]);
    expect(messages.some((m) => m.includes("无法建立变异备份"))).toBe(true);
  });

  it("备份落地后被写坏（读回来不是原文）时同样拒跑", () => {
    // 只挡"写不下去"还不够：Windows 上杀软会把刚写下的文件掏空 —— 拿一份坏备份去
    // 自愈，等于把源码写成截断的原文，比没有台账更糟。所以 arm 有写后校验。
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const codes: number[] = [];
    const messages: string[] = [];
    const badFs = {
      mkdirSync: fs.mkdirSync.bind(fs),
      writeFileSync: fs.writeFileSync.bind(fs),
      readFileSync: ((p: fs.PathLike, enc?: unknown) =>
        String(p).endsWith(".orig") ? "TRUNC" : fs.readFileSync(p, enc as never)) as typeof fs.readFileSync,
    };
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    try {
      loadPending({ exit: (code: number) => void codes.push(code) }, badFs).armPendingRecord(
        path.join(PENDING_DIR, "armed.ts"),
        "ORIGINAL\n",
      );
    } finally {
      console.error = realError;
    }

    expect(codes).toEqual([2]);
    expect(messages.some((m) => m.includes("备份写后校验不一致"))).toBe(true);
  });
});

/**
 * 还原写盘的重试路径。
 *
 * 2026-09-28 连续两次实测：`finally` 里的 `fs.writeFileSync` 抛
 * `UNKNOWN (errno -4094)`（Windows 上杀软/索引器短暂占住刚被改写的文件），
 * 进程就带着**活体变异体**死了 —— 下一轮门禁于是红在无关目标上。
 * 现在还原走 `restoreSource`：重试、不抛、尽力后返回 false 并点名。
 *
 * 手法与 `scripts/masker-selftest.mjs` 一致：按锚点从门禁脚本里抠出函数体，
 * 注进新作用域直接调用（不留第二份实现）。故障用"父目录不存在"制造 ——
 * 各平台都确定性抛 ENOENT；没用 chmod 只读，因为 root 身份下它拦不住写。
 */
describe("restoreSource · 还原写盘不能抛在 finally 里", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  const START_ANCHOR = "/** 同步等待（毫秒）";
  const END_ANCHOR = "/** 一个目标跑完";
  const start = SRC.indexOf(START_ANCHOR);
  const end = SRC.indexOf(END_ANCHOR);

  /** 抠出 sleepSync + restoreSource，注入 fs/path/ROOT/relFromRoot。 */
  function loadRestore(): (file: string, original: string) => boolean {
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(
        `无法在 mutation-check.mjs 里定位 restoreSource（锚点 ${START_ANCHOR} / ${END_ANCHOR} 被改名或移动了？）`,
      );
    }
    const helpers = SRC.slice(start, end);
    const factory = new Function("fs", "path", "relFromRoot", `${helpers}\nreturn { restoreSource };`);
    const { restoreSource } = factory(fs, path, (p: string) => path.relative(ROOT, p));
    return restoreSource as (file: string, original: string) => boolean;
  }

  it("returns true and really puts the original back when the file is writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-restore-"));
    scratch.push(dir);
    const file = path.join(dir, "target.ts");
    fs.writeFileSync(file, "MUTANT\n", "utf8");

    expect(loadRestore()(file, "ORIGINAL\n")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL\n");
  });

  it("gives up out-loud instead of throwing when the write keeps failing", () => {
    // 父目录不存在 → writeFileSync 每次必抛（ENOENT），等价于"句柄一直不放"。
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ox-restore-gone-"));
    scratch.push(base);
    const missing = path.join(base, "nope", "target.ts");

    const messages: string[] = [];
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    let threw: unknown = null;
    let returned: boolean | undefined;
    try {
      returned = loadRestore()(missing, "ORIGINAL\n");
    } catch (e) {
      threw = e;
    } finally {
      console.error = realError;
    }

    // 抛异常就是原缺陷本身：它一抛，进程带着变异体死掉，台账也来不及说清。
    expect(threw).toBeNull();
    expect(returned).toBe(false);
    expect(messages.some((m) => m.includes("反复无法还原") && m.includes("自愈"))).toBe(true);
  });
});

describe("clearPendingRecord · 只清自己这一条", () => {
  /**
   * 按锚点抠出 `clearPendingRecord`，注入 fs/path/PENDING_DIR/pendingBackupName
   * 与一个假 pid —— 手法与本文件其它节一致（"pid"是运行时的，测试必须能决定"我是谁"）。
   * 台账按文件一条后，"别人的"由**文件**天然隔离：清的只是传入 filePath 自己那份。
   */
  function loadClear(myPid: number): (filePath: string, ownsIt?: boolean) => void {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const start = src.indexOf("/** 一个目标跑完");
    const nextDoc = src.indexOf("启动自愈：上一次运行被强杀");
    const end = nextDoc < 0 ? -1 : src.lastIndexOf("/**", nextDoc);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("无法在 mutation-check.mjs 里定位 clearPendingRecord（锚点被改名或移动了？）");
    }
    const slice = src.slice(start, end);
    const factory = new Function(
      "fs",
      "path",
      "PENDING_DIR",
      "pendingBackupName",
      "process",
      `${slice}\nreturn { clearPendingRecord };`,
    );
    const { clearPendingRecord } = factory(
      fs,
      path,
      PENDING_DIR,
      loadPending({ exit: () => undefined }).pendingBackupName,
      { pid: myPid },
    );
    return clearPendingRecord as (filePath: string, ownsIt?: boolean) => void;
  }

  it("台账属于别的 pid 时，备份与台账一个字节都不动", () => {
    const theirs = path.join(PENDING_DIR, "theirs.orig");
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(theirs, "original\n", "utf8");
    const file = path.join(ROOT, "gone.ts");
    writeRecord(path.join(PENDING_DIR, "gone.ts.orig.json"), { file, backup: theirs, pid: 999_999 });

    loadClear(4242)(file);

    expect(fs.readFileSync(theirs, "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(PENDING_DIR, "gone.ts.orig.json"))).toBe(true);
  });

  it("自己这一条的备份与台账一起清掉；别的文件的记录不受牵连", () => {
    const mine = path.join(PENDING_DIR, "mine.orig");
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(mine, "original\n", "utf8");
    const file = path.join(ROOT, "gone.ts");
    writeRecord(path.join(PENDING_DIR, "gone.ts.orig.json"), { file, backup: mine, pid: 4242 });
    // 另一个文件（并行 worker 的现场）：同样 pid，但不在被清的 filePath 上
    const other = path.join(ROOT, "other.ts");
    const otherBackup = path.join(PENDING_DIR, "other.orig");
    fs.writeFileSync(otherBackup, "original\n", "utf8");
    writeRecord(OTHER_RECORD, { file: other, backup: otherBackup, pid: 4242 });

    loadClear(4242)(file);

    expect(fs.existsSync(mine)).toBe(false);
    // clear 按它自己算出的记录路径清（gone.ts.orig.json），不是测试的固定名
    expect(fs.existsSync(path.join(PENDING_DIR, "gone.ts.orig.json"))).toBe(false);
    // 并行语义的核心断言：清 A 不许碰 B
    expect(fs.existsSync(otherBackup)).toBe(true);
    expect(fs.existsSync(OTHER_RECORD)).toBe(true);
  });
});
