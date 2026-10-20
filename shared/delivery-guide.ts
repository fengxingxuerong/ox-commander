import type { DeliveryReceipt } from "./delivery-receipt";
import { isPathInZone } from "./glob";

/**
 * 本次运行的交付面：产物清单 + 怎么验收。
 *
 * 数据源刻意只取**已经有持久事实**的两类：
 *   · 批次改动（审计 `batch-changes` / host 的 `scope.changes`）；
 *   · 交付凭据（验证命令、任务账）。
 *
 * 这里不读盘、不执行命令 —— 桌面 IPC 与 headless/serve 共用同一份推导，
 * 否则两边会各说各的"本次产物"。
 */

export interface DeliveryArtifactFile {
  path: string;
  op: string;
  bytes?: number;
}

export interface DeliveryTaskGroup {
  taskId: string;
  title: string;
  zone: string;
  files: DeliveryArtifactFile[];
}

export interface AcceptanceCommand {
  kind: "verify" | "start";
  label: string;
  command: string;
  args: string[];
}

export interface DeliveryGuide {
  /** 按任务分组；只收有改动的任务。 */
  artifacts: DeliveryTaskGroup[];
  /** 对不上任何任务 zone 的改动（越权处置后的现场、旧记录等）。缺席 = 没有。 */
  unassigned?: DeliveryArtifactFile[];
  commands: AcceptanceCommand[];
  /** 去重后的改动文件总数（= 所有组 + unassigned）。 */
  totalFiles: number;
  /** 本次运行是否已经收尾并产出了凭据（界面据此决定"没有改动"要不要出卡）。 */
  hasReceipt: boolean;
}

/**
 * 推导输入的最小事实形状。桌面传审计记录；headless 传两条合成事实
 * （`batch-changes` + `receipt`），所以两边走的是同一个函数。
 */
export interface DeliveryFact {
  phase: string;
  projectId?: string;
  stage?: string;
  taskId?: string;
  title?: string;
  zone?: string;
  files?: readonly DeliveryArtifactFile[];
  receipt?: DeliveryReceipt;
}

/** `delivery:read` 的返回形状（只读全文；二进制的 content 固定为空串）。 */
export type DeliveryFileRead =
  | { ok: true; content: string; bytes: number; truncated: boolean; binary: boolean }
  | { ok: false; reason: string };

/**
 * 保活中的 dev server（`preview:status` 的返回形状）。
 *
 * 只含可展示事实，不含 ChildProcess —— 渲染层拿不到进程句柄。
 */
export interface PreviewState {
  title: string;
  url: string;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  startedAt: string;
  expiresAt: string;
  running: boolean;
  /** 已退出时的退出码；进程还活着时缺席（字段即承诺）。 */
  exitCode?: number | null;
  /** stdout/stderr 尾部（最多 16KiB）。 */
  log: string;
}

/** package.json 里视为"启动命令"的脚本，按优先级排序。 */
const START_SCRIPTS = ["dev", "start", "preview", "serve"] as const;

/**
 * 一轮流水线的起点标记。桌面端的规划与执行是**两次**调用：规划发 `PRD` /
 * `PLANNING`，而 `orchestrate:start` 直接进 `execute`（只发 `DEVELOPMENT`）——
 * 所以只认 `PRD` 会把"取消后重跑"的两次产物混在一起。取最后一个起点即可。
 */
const RUN_START_STAGES = new Set(["PRD", "PLANNING", "DEVELOPMENT"]);

function lastIndexWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i]!)) return i;
  }
  return -1;
}

/**
 * 从审计式事实推导交付面。
 *
 * 运行边界：以最后一个 `PRD` / `PLANNING` / `DEVELOPMENT` 阶段为本次 run 的
 * 起点；若最后一份凭据之后又出现了派发/批次改动（没有起点阶段的续跑），则以
 * 该凭据为界，只取之后的事实。这样重载看板时不会把上一次 run 的产物混进"本次"。
 */
export function deriveDeliveryGuide(
  records: readonly DeliveryFact[],
  opts: { projectId?: string; packageJson?: string } = {},
): DeliveryGuide {
  let scoped: readonly DeliveryFact[] = records;
  if (opts.projectId !== undefined) {
    scoped = records.filter((r) => r.projectId === opts.projectId);
  }

  const hasReceipt = (r: DeliveryFact): boolean => r.phase === "receipt" && r.receipt !== undefined;
  const lastReceipt = lastIndexWhere(scoped, hasReceipt);
  const lastStart = lastIndexWhere(
    scoped,
    (r) => r.phase === "stage" && RUN_START_STAGES.has(r.stage ?? ""),
  );
  const lastWork = lastIndexWhere(scoped, (r) => r.phase === "batch-changes" || r.phase === "run-start");
  const workAfterReceipt = lastWork > lastReceipt || lastStart > lastReceipt;

  let start = 0;
  if (workAfterReceipt) {
    start = Math.max(lastReceipt + 1, lastStart);
  } else if (lastStart >= 0) {
    start = lastStart;
  } else if (lastReceipt >= 0) {
    const previousReceipt = lastIndexWhere(scoped.slice(0, lastReceipt), hasReceipt);
    start = previousReceipt + 1;
  }
  const segment = scoped.slice(start);

  const tasks: Array<{ taskId: string; title: string; zone: string }> = [];
  const seenTasks = new Set<string>();
  const addTask = (taskId: string, title?: string, zone?: string): void => {
    if (!taskId || seenTasks.has(taskId)) return;
    seenTasks.add(taskId);
    tasks.push({ taskId, title: title ?? taskId, zone: zone ?? "" });
  };

  let receipt: DeliveryReceipt | undefined;
  for (const r of segment) {
    if (r.phase === "receipt" && r.receipt !== undefined) receipt = r.receipt;
    if (r.phase === "run-start") addTask(r.taskId ?? "", r.title, r.zone);
  }
  if (receipt !== undefined) {
    for (const t of receipt.tasks) addTask(t.id, t.title, t.zone);
  }

  const fileMap = new Map<string, DeliveryArtifactFile>();
  for (const r of segment) {
    if (r.phase === "batch-changes") {
      for (const f of r.files ?? []) {
        if (f.path) {
          const next: DeliveryArtifactFile = { path: f.path, op: f.op };
          if (f.bytes !== undefined) next.bytes = f.bytes;
          fileMap.set(f.path, next);
        }
      }
    }
  }

  const remaining = new Map(fileMap);
  const artifacts: DeliveryTaskGroup[] = [];
  for (const task of tasks) {
    const files: DeliveryArtifactFile[] = [];
    for (const [path, file] of remaining) {
      if (isPathInZone(path, task.zone)) {
        files.push(file);
        remaining.delete(path);
      }
    }
    if (files.length > 0) artifacts.push({ ...task, files });
  }

  const guide: DeliveryGuide = {
    artifacts,
    commands: buildCommands(receipt, opts.packageJson),
    totalFiles: fileMap.size,
    hasReceipt: receipt !== undefined,
  };
  const unassigned = [...remaining.values()];
  if (unassigned.length > 0) guide.unassigned = unassigned;
  return guide;
}

function buildCommands(receipt: DeliveryReceipt | undefined, packageJson: string | undefined): AcceptanceCommand[] {
  const out: AcceptanceCommand[] = [];
  const seen = new Set<string>();
  const push = (command: AcceptanceCommand): void => {
    const signature = `${command.command}\n${command.args.join("\n")}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push(command);
  };

  if (receipt !== undefined) {
    for (const check of receipt.checks) {
      if (check.command) {
        push({
          kind: "verify",
          label: `复跑 ${check.kind}`,
          command: check.command,
          args: [...(check.args ?? [])],
        });
      }
    }
  }
  for (const command of startCommands(packageJson)) push(command);
  return out;
}

/**
 * package.json 的启动脚本 → 可复制命令。
 *
 * 只认 dev/start/preview/serve 四个约定名：其余脚本是构建/工具链，拿它们当
 * "怎么验收"会误导。解析失败或无 scripts 都给空数组，不抛 —— 产物面不能因为
 * 一个坏 package.json 整块消失。
 */
export function startCommands(packageJson: string | undefined): AcceptanceCommand[] {
  const out: AcceptanceCommand[] = [];
  if (packageJson === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return out;
  const table = scripts as Record<string, unknown>;
  for (const name of START_SCRIPTS) {
    const value = table[name];
    if (typeof value === "string" && value.trim() !== "") {
      out.push({ kind: "start", label: `启动 · ${name}`, command: "npm", args: ["run", name] });
    }
  }
  return out;
}
