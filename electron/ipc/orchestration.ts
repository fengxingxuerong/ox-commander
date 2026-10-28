/**
 * Orchestration: planning, PRD edits, run start, cancel/pause/resume and the
 * escalation reply channel. Also owns the per-project workspace scaffold.
 *
 * Registration only — all state lives in `./context`.
 */
import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OrchestratorCallbacks, OrchestratorEngine, ResumeState, RunSnapshot } from "../engine";
import { redactSecrets } from "../../shared/redact";
import {
  abortAllApprovals,
  abortAllEscalations,
  buildPlatformLayer,
  clearJournal,
  enginesOf,
  ensureAudit,
  getRunningProjectId,
  logLine,
  readJournal,
  resolveApproval,
  resolveEscalation,
  send,
  setJournalRequirement,
  setRunningProjectId,
  settingsStore,
  stores,
  workspaceRoot,
  writeJournal,
} from "./context";
import type { EscalationAction, PrdDocument, SmokeCheck, Task } from "../../shared/types";
import { parsePrd } from "../../shared/schema";
import {
  formatPlanHistoryBlock,
  formatPlanHistoryForDecompose,
  planDiffOf,
  planHistoryOf,
  planSnapshotOf,
  requirementFingerprint,
  type PlanSnapshot,
} from "../../shared/plan-history";
import { collectPlanFacts, formatPlanFactsBlock } from "../../shared/plan-facts";
import { RECEIPTS_DIR, receiptFilename } from "../../shared/receipt-lib";
import { writeFileAtomic } from "../atomic-file";
import { deliveryStamp } from "../engine/git-export";
import { deriveBoardView } from "../board-derive";
import { stopPreview } from "../preview-manager";
import type { DeliveryReceipt } from "../../shared/delivery-receipt";

/**
 * Scaffold scripts written into each project workspace. The workspace is a plain
 * CommonJS Node project with no dependencies, so verification (build/typecheck/
 * test) runs offline and deterministically.
 */
const WORKSPACE_SCRIPTS = {
  "build.js": [
    "const { execFileSync } = require('node:child_process');",
    "let failed = 0;",
    "for (const f of require('node:fs').readdirSync('src')) {",
    "  if (!f.endsWith('.js')) continue;",
    "  try { new (require('node:vm').Script)(require('node:fs').readFileSync(`src/${f}`, 'utf8'), { filename: f }); } catch (e) { console.error(`${f}: ${e.message}`); failed++; }",
    "}",
    "if (failed) process.exit(1);",
    "console.log('syntax check passed');",
  ].join("\n"),
  "test.js": [
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const files = fs.existsSync('tests') ? fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')) : [];",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, `tests/${f}`], { stdio: 'inherit' });",
    "  if (r.status !== 0) process.exit(r.status ?? 1);",
    "}",
  ].join("\n"),
} as const;

/** Creates the workspace directory plus its package.json and ox-scripts/. */
export function ensureWorkspace(projectId: string): string {
  const root = workspaceRoot(projectId);
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ["src", "tests"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const pkg = path.join(root, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: `ox-${projectId}`,
          version: "0.0.0",
          private: true,
          scripts: {
            build: "node ox-scripts/build.js",
            typecheck: "node ox-scripts/build.js",
            test: "node ox-scripts/test.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    const file = path.join(root, "ox-scripts", name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }
  return root;
}

/**
 * 把一份凭据落进**凭据库**（`<workspace>/.ox/receipts/`）。
 *
 * 与 `projectStore.receiptJson` 的分工：那里是"最新一份"（看板与凭据卡要用），
 * 这里是"一叠"（回归要跑的历史现场）。两者都留下，因为它们的消费方不同 ——
 * 索引（`shared/receipt-lib`）只负责命名，落盘在这里。
 *
 * 三条纪律：
 * 1. **永不 throw**：凭据库是旁路账本，写不进去只写一行日志，绝不追认门禁为假；
 * 2. **原子写**（`writeFileAtomic`）：半截 JSON 会被 `receipt:regress` 读成"读不动"，
 *    一份被写坏的凭据比少一份更坏（它看起来像证据）；
 * 3. **命名只用真事实**（stamp 取落盘时刻、前缀取凭据自己的指纹）—— 凭据没指纹时
 *    `receiptFilename` 抛错，这里接住并**跳过着落**：一份没盖章的凭据进库，
 *    只会在回归时每次都报 unsigned 噪音。
 */
export function saveReceiptToCorpus(root: string, receipt: DeliveryReceipt): string | undefined {
  try {
    const name = receiptFilename(deliveryStamp(), receipt.fingerprint);
    const dir = path.join(root, RECEIPTS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
    return file;
  } catch (err) {
    logLine(`[receipt] 凭据库跳过着落（不影响交付）：${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Builds a fresh engine bound to one project and records it as the project's
 * live engine (for cancel/pause/resume). Always rebuilt from current settings,
 * so settings changes take effect on the next planning/start; re-entry while
 * running is blocked by the runningProjectId checks in the handlers.
 */
export function buildEngine(projectId: string): OrchestratorEngine {
  // 新一次规划/执行开始 = 上一轮预览已过期。先停掉，避免旧 dev server 占着
  // 端口让新的冒烟起不来（预览是增强，不能反过来绊倒验证）。
  stopPreview();
  const projectStore = stores();
  const settings = settingsStore().load();
  const journal = {
    save: (snapshot: RunSnapshot): void => writeJournal(projectId, snapshot),
  };
  const platform = buildPlatformLayer(settings, {
    // 走 logLine（2026-10-13）：实时日志流统一过脱敏 —— 这条通路若绕开，
    // agent/沙箱/熔断报错里的 token 会原样上屏。
    log: logLine,
    journal,
    projectId,
    callbacks: {
      onStage: (stage) => {
        projectStore.update(projectId, { stage });
        // Durable fact: the board rebuilds "where was I" from this after a
        // restart. Cheap JSONL line, no read-modify-write.
        ensureAudit().append({ phase: "stage", projectId, stage });
        send({ type: "stage", stage });
      },
      onTaskStatus: (taskId, status, attempts) => send({ type: "taskStatus", taskId, status, attempts }),
      // The renderer is a display surface: strip credentials before the digest
      // becomes visible/copyable text on the board.
      onTaskOutcome: (taskId, ok, logDigest, meta) =>
        send({
          type: "taskOutcome",
          taskId,
          ok,
          logDigest: redactSecrets(logDigest).slice(0, 2000),
          ...(meta ?? {}),
        }),
      onVerification: (report) => send({ type: "verification", report }),
      onEscalation: (taskId, summary) => send({ type: "escalation", taskId, summary }),
      // 操作者附言的状态回声（C2）：设置/清除/任务成功退休都广播。人写的
      // 东西要即时确认"生效了"，否则分不清没保存还是没派发。
      onTaskNote: (taskId, note) => send({ type: "task-note", taskId, note }),
      // 交付凭据：看板要把它整份留下来（它是这次运行唯一的对外结论），
      // 同时 projectStore 存一份，重载窗口后仍看得到上次交付的结论。
      onReceipt: (receipt) => {
        projectStore.update(projectId, { receiptJson: JSON.stringify(receipt) });
        // 凭据库（2026-10-26，第七轮竞品吸收）：**累积**落一份到
        // `<workspace>/.ox/receipts/<stamp>-<指纹前 8 位>.json`。
        // 为什么不是只留最新那份：`receiptJson` 每次覆盖，而"上次在这里红过"需要实物 ——
        // `receipt:regress` 跑的就是这一叠。失败只写日志：凭据库坏掉不影响交付结论。
        saveReceiptToCorpus(workspaceRoot(projectId), receipt);
        // Durable fact: the receipt also lands in the audit trail so board
        // recovery can show the last delivery verdict after a full restart.
        // Audit JSONL is durable: redact before it hits disk. The receipt is
        // a plain JSON object, so a stringify→redact→parse round-trip is the
        // same boundary the run-end digest already uses.
        try {
          const redacted = JSON.parse(redactSecrets(JSON.stringify(receipt))) as typeof receipt;
          ensureAudit().append({ phase: "receipt", projectId, receipt: redacted });
        } catch {
          // never let recovery bookkeeping break the run
        }
        send({ type: "receipt", receipt });
      },
      // 用量走独立事件而不是日志行：platform 的默认实现只落一行 `[usage] …`，
      // 而看板要的是**字段**（`calls - measuredCalls` 决定这份数字可信到什么程度）。
      // 三条出口（交付 / 取消 / 抛错）都会到 —— 失败的运行一样烧了 token。
      onUsage: (snapshot) => send({ type: "usage", ...snapshot }),
    } satisfies Partial<OrchestratorCallbacks>,
  });
  const engine = platform.engine;
  enginesOf().set(projectId, engine);
  return engine;
}

/**
 * 读本项目的规划历史，并渲染成"上次规划 + 与这次的差异"块（形态 B，2026-10-25）。
 *
 * 两个"不许"：
 * - **读不到不许当成"没有上次"**就不说话 —— 那与"从没规划过"混在一起，人会以为
 *   第一次规划。这里读不到就退化成空块（提示里不产段），但路径本身就是 best-effort：
 *   历史是背景，不是交付条件，读盘失败绝不能让规划起不来。
 * - **不许拿残缺快照凑数**（`planHistoryOf` 里字段缺失的老记录一律跳过）。
 */
function planHistoryBlockFor(
  projectId: string,
  requirement: string,
): { block: string; previous?: PlanSnapshot } {
  try {
    // 只读本项目：审计是全项目共用的一个文件，不按 projectId 过滤就会把别的项目
    // 的规划当成"上次"（那会让两个项目互相污染拆法）。
    const records = ensureAudit()
      .read({ limit: 2000, phase: "plan" })
      .filter((r) => r.projectId === projectId);
    const history = planHistoryOf(records);
    const previous = history[0];
    if (!previous) return { block: "" };
    // 差异：需求有没有改，用**当前需求原文**和上次的指纹比 —— 这是此刻唯一已存在
    // 的事实（任务清单要等拆完才有）。任务级的 added/removed 在落快照那一侧才有意义
    // （见 `recordPlanSnapshot`），所以这里给 `undefined`，块里就不产那一行。
    const changed = requirementFingerprint(requirement) !== previous.requirementHash;
    const diff = {
      requirementChanged: changed,
      taskCountBefore: previous.taskCount,
      // 这次的任务数此刻还不知道：用上次自己的数占位会把"没变"说成"变了"，
      // 所以这一项也用上次的值，并在块里避免印出前后相同的假差异。
      taskCountAfter: previous.taskCount,
      added: [],
      removed: [],
    };
    return { block: formatPlanHistoryBlock(previous, diff), previous };
  } catch {
    return { block: "" };
  }
}

/**
 * 聚合本项目的可核事实并渲染成块（2026-10-25）。
 *
 * 三条纪律（与 `shared/plan-facts.ts` 顶部的声明一一对应）：
 * - **只读**：不修改审计、不写回 `OX-PLAN.md`、不参与任何决策；
 * - **只本项目**：跨项目汇总会把 A 的坑算到 B 头上；
 * - **可复现**：聚合层不印时间戳、键序固定 —— 同一份审计，任何时刻跑都同一段文字。
 *
 * 读失败 → 空块（事实是参考，不是交付条件），但**不静默**：写一行日志。
 */
function planFactsBlockFor(projectId: string, lastPlan?: PlanSnapshot): string {
  try {
    const records = ensureAudit()
      .read({ limit: 5000 })
      .filter((r) => r.projectId === projectId);
    const block = formatPlanFactsBlock(collectPlanFacts(records, lastPlan));
    if (block !== "") {
      logLine(`[plan-facts] 已注入上一轮的可核事实（${block.length} 字符）`);
    }
    return block;
  } catch (err) {
    logLine(`[plan-facts] 读取审计事实失败（不影响规划）：${(err as Error).message}`);
    return "";
  }
}

/**
 * 落一条规划快照（形态 B）。
 *
 * 刻意 best-effort：历史是背景，不是交付条件 —— 磁盘满 / 权限不对都不该让一次
 * 规划失败。但也不静默：写不进去时说一声，否则"历史里为什么少了这一版"永远查不出来。
 *
 * 差异（`planDiffOf`）在这里算：**只有这一刻才知道"上次 vs 这次"的完整对照** ——
 * 注入那次规划时这次的清单还不存在，落盘时才知道。算出来的差异写进日志，让人能
 * 在日志里读到"这一版比上一版多了/少了哪几个任务"，而不必自己去翻审计。
 */
function recordPlanSnapshot(
  projectId: string,
  requirement: string,
  prd: PrdDocument,
  tasks: ReadonlyArray<Task>,
): void {
  try {
    const snapshot = planSnapshotOf({
      ts: new Date().toISOString(),
      requirement,
      prd,
      tasks,
    });
    const previous = planHistoryOf(
      ensureAudit()
        .read({ limit: 2000, phase: "plan" })
        .filter((r) => r.projectId === projectId),
    )[0];
    ensureAudit().append({ phase: "plan", projectId, plan: snapshot });
    const diff = planDiffOf(previous, snapshot);
    if (diff) {
      logLine(
        `[plan-history] 本次规划已落快照：需求${diff.requirementChanged ? "已改动" : "未变"}，` +
          `任务数 ${diff.taskCountBefore} → ${diff.taskCountAfter}` +
          (diff.added.length > 0 ? `，新增「${diff.added.join("、")}」` : "") +
          (diff.removed.length > 0 ? `，不再出现「${diff.removed.join("、")}」` : ""),
      );
    }
  } catch (err) {
    logLine(`[plan-history] 这次规划的落盘快照没写成（不影响规划）：${(err as Error).message}`);
  }
}

/**
 * 启动一次编排运行的前置判定（**唯一实现**）：单飞闸 + 计划存在性。
 *
 * `orchestration:start` 与桌面自动化的调度环（M5b）共用这一道闸 —— 两边各写
 * 一遍"忙不忙/有没有计划"必然漂，而漂了的后果是自动化触发与手动启动对"能不能
 * 起一个 run"给出不同答案。判定是同步的，于是调度器能在**不起火**的前提下
 * 区分 busy 与 no-plan（返回三态之一，不靠错误消息 sniff）。
 *
 * 顺手把 batches/smoke 一起带回来：`startProjectRun` 与闸门读同一份记录，
 * 不会出现"闸门放行后记录又变了"的半空档。
 */
export type RunGate =
  | { kind: "busy"; message: string }
  | { kind: "no-plan"; message: string }
  | { kind: "ready"; batchesJson: string; smokeJson?: string };

export function runGate(projectId: string): RunGate {
  const running = getRunningProjectId();
  if (running) return { kind: "busy", message: `项目 ${running} 正在执行中，无法同时启动` };
  const rec = stores().get(projectId);
  if (!rec?.batchesJson) return { kind: "no-plan", message: `no plan for project ${projectId}` };
  return {
    kind: "ready",
    batchesJson: rec.batchesJson,
    ...(rec.smokeJson !== undefined ? { smokeJson: rec.smokeJson } : {}),
  };
}

/**
 * 跑一个项目的编排（手动启动与自动化触发共用同一条路）。
 *
 * 与 `buildEngine` 的分工：那个造引擎（每次规划/执行都重建，设置改动即时生效），
 * 这个管"一次运行的完整生命周期"（闸门 → 置运行标志 → execute → 收尾）。
 *
 * **断点续跑（2026-10-25）**：启动前先看这个项目的 checkpoint journal —— 有快照且
 * 需求没变就接着上次跑到的地方继续，而不是从零重做。此前桌面端只写不读，
 * 长 run 被强杀或关窗后一律从头开始（规划重做、已完成批次重做）。
 */
export async function startProjectRun(projectId: string): Promise<void> {
  const gate = runGate(projectId);
  if (gate.kind !== "ready") throw new Error(gate.message);
  const engine = buildEngine(projectId);
  const resume = resumeStateFor(projectId);
  // journal 外壳要记下这份进度属于哪份需求 —— 由宿主在起跑时设，收尾时清
  // （不清的话，同一个进程紧接着跑另一个项目，会把上一个项目的需求写进去）。
  const requirement = stores().get(projectId)?.requirement;
  setJournalRequirement(requirement);
  setRunningProjectId(projectId);
  try {
    // 续跑时必须用**快照里的 batches**：那是上次真正跑过的计划。用项目记录里当前的
    // batches 会把"上次跑到哪"与"这次要跑什么"错配（两次规划之间重规划过的话，
    // 已完成集合与批次就对不上了）。
    const batches = resume ? (resume.snapshot.batches as Task[][]) : (JSON.parse(gate.batchesJson) as Task[][]);
    const smoke: SmokeCheck[] = resume
      ? (resume.snapshot.smoke ?? [])
      : gate.smokeJson
        ? (JSON.parse(gate.smokeJson) as SmokeCheck[])
        : [];
    const opts = resume
      ? { smoke, resume: resume.state }
      : { smoke };
    await engine.execute(batches, ensureWorkspace(projectId), opts);
    // 跑完即清快照（2026-10-25 修正：**无条件**，不再只清续跑那条路）。
    //
    // 为什么必须无条件：`execute` 在执行中会写快照（每一批/每一轮 save 一次），所以
    // **全新 run 也会留下快照**。只清续跑路径的话，"下一次启动是续跑还是全新"就取决于
    // "上一次启动是不是续跑" —— 一个自相矛盾的状态机：首次启动成功后留下的快照会让
    // 第二次启动变成续跑（全部任务已完成 ⇒ 跳过一切、只重跑验证），而它自己跑完又把
    // 快照清掉，于是第三次又是全新。这正是上一行注释警告的"看着成功、其实空转"。
    //
    // 判据落在**返回 vs 抛出**上，而不是"有没有续过"：
    //   · `execute` **正常返回** ⇒ 这轮跑到了终局（交付或带着失败结论收尾），
    //     那份快照不再是"可续的现场"，清掉让下一次启动回到"点开始 = 全新跑"；
    //   · `execute` **抛出** ⇒ 被取消 / 崩溃 / 预算耗尽，现场是合法的续跑点，保留。
    // 注意 headless 刻意相反（`run-spec.ts` 从不清）：那边 `ox-run-journal.json` 是
    // 同一份 spec 的续跑入口，由宿主脚本按退出码决定要不要重投。桌面是 GUI，
    // "点开始就该从零开始"比"同一个需求永远续跑"更不容易被误读。
    clearJournal(projectId);
  } finally {
    setRunningProjectId(null);
    setJournalRequirement(undefined);
  }
}

/**
 * 决定这次能不能续跑，并把结论说破（"静默续跑"与"静默不续跑"都是坏的）。
 *
 * 三条判据：快照存在、可解析、且**需求没变**。需求变了绝不能续 —— 那是上次的
 * 计划，用在这次的需求上等于拿别人的进度交差。
 */
function resumeStateFor(projectId: string): { snapshot: RunSnapshot; state: ResumeState } | undefined {
  const rec = stores().get(projectId);
  const read = readJournal(projectId);
  if (read.kind === "absent") return undefined;
  if (read.kind === "corrupted") {
    logLine("[journal] 快照解析失败，按全新运行处理");
    return undefined;
  }
  const snapshot = read.snapshot;
  // 需求匹配：快照外壳里记着写下它的那份需求。判据与 headless 同源
  // （`createFileJournal` 也把 requirement 放在外壳上）—— 不同需求续上别人的进度
  // 是最坏的一种错，宁可重跑。
  //
  // 这里也覆盖了"快照属于别的项目/别的需求"这一整类：`readJournal` 不认识需求，
  // 它只报"有没有快照、坏没坏"，比对只能在这一层做。
  if (rec && read.requirement !== undefined && read.requirement !== rec.requirement) {
    logLine("[journal] 快照属于另一份需求，按全新运行处理");
    return undefined;
  }
  if (snapshot.allDone.length === 0 && snapshot.round === 0) {
    // 快照刚写下第一笔（规划完、一批都还没跑）：续不续都一样，别拿它当"恢复"说事。
    return undefined;
  }
  logLine(
    `[journal] 断点续跑：恢复快照（round ${snapshot.round}，已完成 ${snapshot.allDone.length} 个任务），跳过规划`,
  );
  return {
    snapshot,
    state: {
      ...(snapshot.smoke !== undefined ? { smoke: snapshot.smoke } : {}),
      allDone: snapshot.allDone,
      skipped: snapshot.skipped,
      attempts: snapshot.attempts,
      round: snapshot.round,
      extraRounds: snapshot.extraRounds,
      lastDigest: snapshot.lastDigest,
    },
  };
}

export function registerOrchestrationHandlers(): void {
  ipcMain.handle("orchestration:planning", async (_e, projectId: string) => {
    const rec = stores().get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (getRunningProjectId() === projectId) throw new Error("项目正在执行中，请先取消再重新规划");
    const engine = buildEngine(projectId);
    // 规划历史（形态 B，2026-10-25）：先读上次的落盘快照，把它作为背景注入这次规划。
    // 读的是**审计事实**而不是模型自述 —— 这是与"让模型记住上次"最根本的区别。
    const history = planHistoryBlockFor(projectId, rec.requirement);
    // 可核事实（2026-10-25）：上一轮的账（失败按原因、zone 冲突、仲裁处置）。
    // 与历史块同一个数据源、同一个过滤口径 —— 只读本项目、只读落盘事实。
    const facts = planFactsBlockFor(projectId, history.previous);
    // 项目约定（B3）：规划阶段也注入 —— 约定影响"技术栈/边界怎么定"，
    // 只在执行阶段带进去的话，PRD 早就把约定违背了。
    const prd = await engine.generatePrd(
      rec.requirement,
      workspaceRoot(projectId),
      history.block,
      facts,
    );
    stores().update(projectId, { prdJson: JSON.stringify(prd), stage: "PLANNING" });
    send({ type: "stage", stage: "PLANNING" });
    // 与 headless 入口保持一致：把验证命令交给 zone 覆盖校验。它引用的文件若
    // 不被任何任务 zone 覆盖，重修会把整个预算烧在一个不可能完成的任务上。
    //
    // 上次拆法（2026-10-25）：任务级差异只可能在**分解**这一步被用上 —— PRD 提示那一刻
    // 这次的任务清单还不存在，所以"上次拆出哪几个任务"只能在这里给。同一个 `previous`
    // 既喂规划（上次想到哪一步）、也喂分解（上次是怎么切的）。
    const { batches, smoke } = await engine.decompose(
      prd,
      settingsStore().load().verificationCommands,
      formatPlanHistoryForDecompose(history.previous),
    );
    stores().update(projectId, { batchesJson: JSON.stringify(batches), smokeJson: JSON.stringify(smoke) });
    // 收官即落快照：这次拆成什么样，是下一次规划的"上次"。落盘失败绝不能让规划失败
    // （历史是背景，不是交付条件）。
    recordPlanSnapshot(projectId, rec.requirement, prd, batches.flat());
    return { prd, batches };
  });

  ipcMain.handle("orchestration:update-prd", async (_e, projectId: string, prd: PrdDocument) => {
    const rec = stores().get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (getRunningProjectId() === projectId) throw new Error("项目正在执行中，请先取消再修改 PRD");
    // 入参校验（2026-10-13）：PRD 从渲染层来（用户在 PRD 页编辑过），直接落盘=
    // 坏形状带进 decompose。守卫在前（项目不存在/执行中先说），形状在后。
    const checked = parsePrd(prd);
    stores().update(projectId, { prdJson: JSON.stringify(checked), batchesJson: undefined, smokeJson: undefined });
    const engine = buildEngine(projectId);
    // 人工编辑 PRD 后的那次分解同样是"重新切一遍"：把上次拆法给它，人改完 PRD
    // 往往只是想调 PRD 而不是把整套任务重排一遍。
    const history = planHistoryBlockFor(projectId, rec.requirement);
    const { batches, smoke } = await engine.decompose(
      checked,
      settingsStore().load().verificationCommands,
      formatPlanHistoryForDecompose(history.previous),
    );
    stores().update(projectId, { batchesJson: JSON.stringify(batches), smokeJson: JSON.stringify(smoke) });
    // 人工改 PRD 也是一次"规划"，同样落快照：否则改完再重规划时，历史会跳过这一版，
    // 看起来像"我们从来没定过这个拆法"。
    recordPlanSnapshot(projectId, rec.requirement, checked, batches.flat());
    return { prd: checked, batches };
  });

  // Board recovery (facts/derived split): the renderer asks for the board view
  // derived from the audit trail when it mounts, so a restart shows the last
  // run's progress instead of a blank board. The derive layer is a pure
  // function; this handler is only the IO boundary around it.
  ipcMain.handle("board:recovery", () => deriveBoardView(ensureAudit().read()));

  ipcMain.handle("orchestration:start", async (_e, projectId: string) => {
    await startProjectRun(projectId);
  });

  ipcMain.handle("orchestration:cancel", () => {
    for (const e of enginesOf().values()) e.cancel();
    // Unblock any escalation wait so execute() can observe the cancel.
    abortAllEscalations();
    // Unblock any approval wait the same way — but fail-closed: nobody is
    // going to answer now, so the pending command must not run.
    abortAllApprovals();
  });
  ipcMain.handle("orchestration:pause", () => {
    for (const e of enginesOf().values()) e.pause();
  });
  ipcMain.handle("orchestration:resume", () => {
    for (const e of enginesOf().values()) e.resume();
  });

  ipcMain.handle("orchestration:escalation-decide", (_e, taskId: string, action: EscalationAction) => {
    if (!resolveEscalation(taskId, action)) throw new Error(`没有等待决策的任务：${taskId}`);
    return true;
  });

  /**
   * 操作者附言（C2）：给一个任务挂一句"下一次派发时带上"的指示；空串 = 清除。
   *
   * 只对**在跑的 run** 有效（附言的存活范围是引擎实例）：没有 run 时写哪里
   * 都不对 —— 落盘会 invent 一个跨 run 语义，而那正是 PRD 评审页的职责。
   * 所以这里找不到引擎就明说，不静默成功。
   *
   * taskId 不存在的后果由 UI 的任务清单过滤（人只能给看得见的任务写），
   * 引擎侧不重复建一套白名单 —— 写了但对不上任何任务的附言到不了任何派发，
   * 而"对不上"这件事看板上看得见。
   */
  ipcMain.handle("orchestration:task-note", (_e, taskId: string, note: string) => {
    if (typeof taskId !== "string" || taskId === "") throw new Error("taskId 必须是非空字符串");
    if (typeof note !== "string") throw new Error("note 必须是字符串（空串 = 清除）");
    const running = getRunningProjectId();
    const engine = running ? enginesOf().get(running) : undefined;
    if (!engine) throw new Error("没有在跑的 run：附言只对本次运行有效（运行前请用 PRD 评审）");
    engine.setOperatorNote(taskId, note);
    return true;
  });

  ipcMain.handle("orchestration:approval-decide", (_e, requestId: string, granted: boolean) => {
    if (!resolveApproval(requestId, granted)) throw new Error(`没有等待审批的请求：${requestId}`);
    return true;
  });
}
