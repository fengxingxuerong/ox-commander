/**
 * Zone coverage check for a decompose plan.
 *
 * Why this exists: the planner is free to invent its own zone directory names
 * ("tests/unit", "tests/runner"), but the PRD names the concrete files the
 * deliverable must contain ("tests/greet.test.js"). When those two disagree,
 * every write to the declared file is a zone violation: the sandbox reverts it,
 * verification keeps failing on the missing file, and the run burns its whole
 * repair budget in a loop that cannot terminate.
 *
 * Observed in a real multi-agent run: zones `tests/unit` + `tests/runner`, PRD
 * requiring `tests/greet.test.js` (directly under `tests/`) → 3 revert
 * verdicts, `no test files found in tests/` forever.
 *
 * The guard is deliberately one-directional: it only fails a plan when a file
 * the PRD *explicitly names* is owned by no zone. It never rewrites zones —
 * widening a zone automatically would silently grant write access the planner
 * did not intend, which is exactly what the zone model exists to prevent.
 *
 * Pure TS (no node, no DOM): both the renderer and the electron project compile
 * `shared/`, and the headless entry point must be able to run this too.
 */
import { isPathInZone } from "./glob";
import type { PrdDocument, Task } from "./types";

/**
 * File paths that a PRD line explicitly names, as project-relative posix paths.
 *
 * Extraction is conservative — a false negative (missing a path) merely skips
 * the check, while a false positive would reject a perfectly good plan. So a
 * token only counts when it looks like a real *nested* relative file path.
 */
export function extractDeclaredPaths(text: string): string[] {
  const found = new Set<string>();
  // Tokens like `src/app/greet.js`, `tests/greet.test.js`, `docs/README.md`.
  const token = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+/g;
  for (const match of text.matchAll(token)) {
    // A match that continues a path fragment is not a path start: `../x/y.js`
    // must not degrade into the plausible-looking `x/y.js`. Guarding on the
    // preceding character is the only reliable way — a leading lookahead lets
    // the engine simply start matching one character later.
    const start = match.index ?? 0;
    const prev = start > 0 ? text[start - 1] ?? "" : "";
    if (prev === "." || prev === "/" || prev === "\\") continue;
    // Strip trailing punctuation that a sentence may glue on.
    const cleaned = match[0].replace(/[.,;:)\]}>"'`]+$/, "");
    if (cleaned === "" || cleaned.includes("..")) continue;
    const segments = cleaned.split("/").filter((s) => s !== "");
    // Require a directory part. A bare filename is almost always a reference to
    // a protected path in prose ("do not modify package.json"), and treating it
    // as an artifact would reject plans that are perfectly fine.
    if (segments.length < 2) continue;
    // 代码概念黑名单（2026-09-27 --real 演习实测）：PRD 大脑描述 CommonJS
    // 接口时写出 "require/module.exports" 这类斜杠连接的模块系统概念，两段
    // 形态恰好骗过上面的启发式。任何一段（小写化）命中即判为代码引用：
    // 分解层无法让 zone 覆盖一个不存在的文件，这种假路径会让规划校验
    // 重试全部白烧、演习在 PLANNING 就 exit 1。
    if (segments.some((s) => CODE_CONCEPT_SEGMENTS.has(s.toLowerCase()))) continue;
    found.add(cleaned);
  }
  return [...found].sort();
}

/** 模块系统 / 代码概念关键词：出现在"路径"段中几乎必然是代码引用而非文件。 */
const CODE_CONCEPT_SEGMENTS = new Set([
  "require",
  "import",
  "export",
  "exports",
  "module.exports",
  "default",
]);

/** Every path the PRD names anywhere a file could be introduced. */
export function declaredArtifactPaths(prd: PrdDocument): string[] {
  const parts: string[] = [
    prd.goal,
    ...prd.features,
    ...prd.acceptanceCriteria,
  ];
  const found = new Set<string>();
  for (const part of parts) {
    for (const p of extractDeclaredPaths(part)) found.add(p);
  }
  return [...found].sort();
}

export interface ZoneCoverageGap {
  /** The declared file no zone owns. */
  path: string;
  /** Zones that exist but do not cover it. */
  zones: string[];
  /**
   * Where the path came from. `prd` = the PRD names it; `verification` = the
   * host's `verificationCommands` reference it. The second source used to be
   * invisible here: a verify command pointing at a file no zone owns makes every
   * repair round fail identically and burns the whole budget. Real case
   * 2026-09-20 — verify ran `node --check src/strutil/strutil.js` while the
   * planner split into `src/strutil/slugify` + `src/strutil/truncate`, so 3
   * repair rounds could never produce the file the verifier asked for.
   */
  source: "prd" | "verification";
}

/**
 * Declared artifact paths that no task's zone owns.
 *
 * Paths inside protected prefixes (`.git/`, `node_modules/`, `ox-scripts/`)
 * are skipped: those are intentionally unwritable, and a PRD mentioning them is
 * usually describing a constraint ("do not touch package.json") rather than
 * asking for a file to be produced.
 */
export function findOrphanPaths(
  prd: PrdDocument,
  tasks: readonly Task[],
  protectedPrefixes: readonly string[] = ["node_modules/", ".git/", "ox-scripts/"],
  extraDeclared: readonly string[] = [],
): ZoneCoverageGap[] {
  const declared = declaredArtifactPaths(prd);
  const extra = [...new Set(extraDeclared)].sort();
  if ((declared.length === 0 && extra.length === 0) || tasks.length === 0) return [];
  const zones = [...new Set(tasks.map((t) => t.zone))];
  const gaps: ZoneCoverageGap[] = [];
  const seen = new Set<string>();
  const check = (path: string, source: ZoneCoverageGap["source"]): void => {
    if (seen.has(path)) return;
    if (protectedPrefixes.some((p) => path.startsWith(p))) return;
    if (zones.some((z) => isPathInZone(path, z))) return;
    seen.add(path);
    gaps.push({ path, zones, source });
  };
  for (const path of declared) check(path, "prd");
  for (const path of extra) check(path, "verification");
  return gaps;
}

/**
 * Human-readable summary of the gaps, for logs and error messages.
 * Callers decide whether a gap is fatal (the orchestrator fails the plan).
 */
export function describeZoneGaps(gaps: readonly ZoneCoverageGap[]): string {
  return gaps
    .map(
      (g) =>
        `${g.path}（${g.source === "verification" ? "验证命令引用" : "PRD 声明"}；现有 zone：${g.zones.join("、") || "无"}）`,
    )
    .join("；");
}

/**
 * 契约路径合规（2026-10-06 --real 真跑的负结果逼出来的一层）。
 *
 * 一条因果链，当场看到的：规划官把 t1 的 zone 划成目录 `src/core/csv`，而契约要求的是
 * 文件 `src/core/csv.js`。`isPathInZone` **刻意**把后者算作前者之内（见 `shared/glob.ts`
 * 里 `src/duration` vs `src/duration.js` 的说明），于是执行者交出 `src/core/csv/index.js`
 * —— **zone 合法、等价布局、契约非法**。三样东西都看不见它：
 * 派发前的 zone 覆盖检查只问"有没有 zone 认领"（有）、靶项目的 build/typecheck 只做
 * 语法检查（过）、`node --test` 那时因为 tests/ 为空而红，红的理由还不是这个。
 * 最后是独立验收 `node src/cli.js` 一句 `Cannot find module './core/csv.js'` 才现形。
 *
 * 所以这一层只判一件事：**任务描述里点名的路径，批次跑完之后在不在盘上**。
 * 刻意不做的事，比做的事重要：
 * - **不判内容**（内容对不对是 smoke / 验证那两层的职责，这里连读都不读文件）；
 * - **不改 `isPathInZone`**（两种形状都可写是设计选择，收紧它等于改沙箱权限语义）；
 * - **归属不唯一就不判**：一条路径被两个任务的 zone 同时认领（或无人认领）时，
 *   判红会把别人的活儿算到它头上，而误判的代价是一整轮修预算白烧 —— 与
 *   `extractDeclaredPaths` 同一套"宁可漏判不可误判"的取向；
 * - **义务只认任务自己的 description**，不认 PRD：执行者拿到的是这段文字，
 *   "点名的文件"只有在对它说话的时候才是要求。
 */
export interface ContractPathGap {
  taskId: string;
  /** 描述里点名、但盘上不存在的相对路径。 */
  path: string;
  /**
   * 点名的文件没有，但 `<同名目录>/index.<ext>` 有 ⇒ 大概率是"目录 + index"布局漂移。
   * 这个字段存在的理由：**只说"文件不存在"会把执行者带去改内容**，而问题在路径形状。
   */
  indexLayout: string | null;
}

export interface ContractPathReport {
  gaps: ContractPathGap[];
  /** 真正核过的路径数。0 意味着这一层什么都没检查 —— 调用方必须把它说出来。 */
  checked: number;
  /** 归属不唯一（或无归属）而被放过的路径，附原因，供日志说明判据边界。 */
  ambiguous: string[];
}

/**
 * 探针只接受**干净的相对路径**：不含 `..`、不以 `/`、`\`、盘符或 UNC 开头。
 *
 * `extractDeclaredPaths` 已经把这些形状挡在门外（正则首字符是词字符、含 `..` 的整条丢弃），
 * 但这一层的输入来自模型写的散文，而它的输出是一次对宿主文件系统的 `existsSync` ——
 * **不能把安全性寄托在上游提取器的启发式上**。守卫放在这里，宿主拿到的谓词就可以直接 join。
 */
/** `src/core/csv.js` → 试 `src/core/csv/index.js` / `.mjs` / `.cjs`。 */
function probeIndexLayout(path: string, exists: (rel: string) => boolean): string | null {
  const at = path.lastIndexOf("/");
  const dir = at < 0 ? "" : path.slice(0, at);
  const base = (at < 0 ? path : path.slice(at + 1)).replace(/\.[A-Za-z0-9]+$/, "");
  if (base === "") return null;
  for (const ext of [".js", ".mjs", ".cjs"]) {
    const cand = `${dir ? `${dir}/` : ""}${base}/index${ext}`;
    if (exists(cand)) return cand;
  }
  return null;
}

export function checkContractPaths(
  tasks: readonly Task[],
  exists: (rel: string) => boolean,
): ContractPathReport {
  const owners = new Map<string, string[]>();
  for (const t of tasks) {
    for (const p of extractDeclaredPaths(t.description)) {
      if (!isPathInZone(p, t.zone)) continue; // 不是这个任务该交的东西
      const list = owners.get(p) ?? [];
      if (!list.includes(t.id)) list.push(t.id);
      owners.set(p, list);
    }
  }
  const gaps: ContractPathGap[] = [];
  const ambiguous: string[] = [];
  let checked = 0;
  for (const [path, list] of [...owners.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length !== 1) {
      ambiguous.push(`${path}（被 ${list.join("、")} 认领）`);
      continue;
    }
    checked += 1;
    if (exists(path)) continue;
    gaps.push({ taskId: list[0]!, path, indexLayout: probeIndexLayout(path, exists) });
  }
  return { gaps, checked, ambiguous };
}

/**
 * Paths referenced by a host's verification commands (`args` entries that look
 * like nested relative files). Reuses `extractDeclaredPaths`, so a bare filename
 * such as `package.json` is ignored — the same false-positive guard.
 */
export function verificationCommandPaths(
  commands: readonly { args?: readonly string[] }[],
): string[] {
  const found = new Set<string>();
  for (const c of commands) {
    for (const arg of c.args ?? []) {
      for (const p of extractDeclaredPaths(arg)) found.add(p);
    }
  }
  return [...found].sort();
}
