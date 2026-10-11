/**
 * 交付后的可选 git 导出（2026-10-11，竞品刷新清单 5.7 的**本地半边**）：
 * 交付过硬门禁后，把本次 run 计划覆盖（task zone）内的改动导出成
 * `git 分支 + commit`，供操作者自行 review / 推送 / 建 PR。
 *
 * **为什么是 zone 过滤而不是全工作树**：共享工作区是本项目的路线，工作树里
 * 完全可能有操作者自己的未提交改动。commit 只收落在本次 run 的任务 zone 之内的
 * 路径——"计划覆盖的改动"，zone 外的脏东西（包括 zone 外的 agent 溢出，那已被
 * 仲裁处理过）一律不碰。⚠️ 由此的诚实边界：**zone 内的既有未提交改动会一并进
 * commit**；要干净的导出，从干净工作区起跑。
 *
 * **刻意不在 v1 里做的**（5.7 的远端半边，见刷新文档 §五）：push / PR / CI 失败
 * 回流——那需要远端凭据与回流路由，是独立的信任面；本地硬门禁先行，分发层
 * 只做分发。因此本模块只产本地分支，**永不 push**。
 *
 * 命令面纪律：每条 git 调用都过 `CommandPolicy`（push/reset/… 的拒绝地板对
 * 我们自己的导出同样生效——加未来子命令时地板会拦）；zone 内路径里含 shell
 * 元字符的单条跳过（文件名是仓库里的事实，不是我们选的），不让一个怪文件名
 * 拖垮整个导出。
 */
import { spawn } from "node:child_process";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { createDefaultCommandPolicy } from "../sandbox/command-policy";
import { scopedEnv } from "../agents/scoped-env";
import { isPathInZone } from "../../shared/glob";

export interface GitExportInput {
  projectRoot: string;
  /** 本次 run 的全部任务 zone（相对项目根）；空数组 = 没有可归属的改动。 */
  zones: readonly string[];
  /** 目标分支名（已由调用方保证字符集，见 `BRANCH_RE`）。 */
  branch: string;
  /** commit 信息。 */
  message: string;
  /** 单条 git 命令的超时（毫秒）；默认 120s。 */
  timeoutMs?: number;
  /**
   * 命令执行器（默认真实 spawn，测试注入）。返回 exit code 与输出；
   * **不抛错**——非零退出码用 `code` 表达。
   */
  run?: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface GitExportResult {
  ok: boolean;
  /** 结构化跳过原因（ok=true 且什么都没提交时出现）。 */
  skipped?: "no-repo" | "no-changes" | "no-zone-files";
  branch?: string;
  commit?: string;
  filesCommitted?: number;
  /** 失败原因（ok=false 时出现，stderr 尾部 200 字符）。 */
  reason?: string;
  /** 因元字符/策略被跳过的路径（提示性，不致命）。 */
  skippedPaths?: string[];
}

/** 分支名字符集：git ref 安全 + 我们生成的固定前缀，杜绝注入面。 */
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

/**
 * 分支/commit 信息的时间戳段（本地时间 yyyyMMdd-HHmmss）。同一秒内两次交付会
 * 重置同名分支（checkout -B 语义，以最新交付为准）——桌面端单实例、headless
 * 一次一 run，这是理论边界不是现实路径。
 */
export function deliveryStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 单次 `git add` 的参数字节预算（Windows cmdline 上限 8191，留足余量分块）。 */
const ADD_CHUNK_BYTES = 6000;

type Runner = (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 默认执行器：与 verifier 同构——buildSpawnSpec 包装 + scopedEnv + 超时杀树。cwd 是项目根。 */
export function makeGitRunner(timeoutMs: number, cwd: string): Runner {
  return (command, args) =>
    new Promise((resolve) => {
      let settled = false;
      const plan = buildSpawnSpec(command, [...args]);
      const child = spawn(plan.file, plan.args, {
        cwd,
        env: scopedEnv(),
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ code: -1, stdout, stderr: `${stderr}\n[git-export] 超过 ${Math.round(timeoutMs / 1000)}s，已终止` });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

function tail(text: string, max = 200): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

/**
 * 解析 `git status --porcelain -z` 的输出：记录间以 NUL 分隔；**重命名/拷贝记录
 * 带两个路径段**（新路径在前，原路径紧跟其后自成一段——必须消费掉，否则原路径
 * 会被当成一条独立改动）。特殊字符路径被 git 以 C 风格引号包裹，这里剥引号并
 * 还原 `\"` / `\\` 两种转义（八进制转义的奇名路径不在 v1 范围——zone 过滤会
 * 自然排除它们，导出少收文件是安全侧的失败）。返回改动路径（相对项目根）。
 */
export function parseStatusZ(raw: string): string[] {
  const out: string[] = [];
  const segments = raw.split("\0");
  for (let i = 0; i < segments.length; i++) {
    const record = segments[i]!;
    if (record.length < 4) continue; // 两字符状态 + 空格 + 至少 1 字符路径
    const status = record.slice(0, 2);
    let path = record.slice(3);
    if (path.startsWith(`"`) && path.endsWith(`"`) && path.length >= 2) {
      path = path.slice(1, -1).replace(/\\"/g, `"`).replace(/\\\\/g, "\\");
    }
    // 未跟踪目录以 "/" 结尾（"?? src/"）：git add 该目录即收整棵
    out.push(path.replace(/\/+$/, ""));
    if (status.includes("R") || status.includes("C")) i += 1; // 消费原路径段
  }
  return out;
}

/** 主入口。永不 throw：所有失败都折进结果对象，导出永远不影响交付结论。 */
export async function exportDeliveryBranch(input: GitExportInput): Promise<GitExportResult> {
  const run: Runner =
    input.run ??
    ((command, args) => makeGitRunner(input.timeoutMs ?? 120_000, input.projectRoot)(command, args));
  const policy = createDefaultCommandPolicy();

  // 0. 分支名先自证：这不是仓库里的事实，是我们生成的事实，必须守自己的字符集。
  if (!BRANCH_RE.test(input.branch)) {
    return { ok: false, reason: `分支名不合法：${JSON.stringify(input.branch)}` };
  }

  // 1. 得是个 git 仓库（git 不在/不在仓库内 → 跳过，不是失败）。
  const repo = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (repo.code !== 0 || repo.stdout.trim() !== "true") {
    return { ok: true, skipped: "no-repo" };
  }

  // 2. 工作树改动清单（含未跟踪；-z 免转义）。
  const status = await run("git", ["status", "--porcelain", "-z"]);
  if (status.code !== 0) {
    return { ok: false, reason: `git status 失败：${tail(status.stderr)}` };
  }
  const changed = parseStatusZ(status.stdout);
  if (changed.length === 0) {
    return { ok: true, skipped: "no-changes" };
  }

  // 3. 只收 zone 内的路径；元字符/策略拒绝的单条跳过（怪文件名不拖垮导出）。
  const skippedPaths: string[] = [];
  const inZones = changed.filter((rel) => {
    if (!input.zones.some((z) => isPathInZone(rel, z))) return false;
    const gate = policy.check("git", ["add", "--", rel]);
    if (!gate.ok) {
      skippedPaths.push(`${rel}（${gate.reason}）`);
      return false;
    }
    return true;
  });
  if (inZones.length === 0) {
    return {
      ok: true,
      skipped: "no-zone-files",
      ...(skippedPaths.length > 0 ? { skippedPaths } : {}),
    };
  }

  // 4. 建分支（-B：同名已存在则重置到当前 HEAD——重复导出以最新交付为准）。
  const checkout = await run("git", ["checkout", "-B", input.branch]);
  if (checkout.code !== 0) {
    return { ok: false, reason: `git checkout 失败：${tail(checkout.stderr)}`, ...(skippedPaths.length > 0 ? { skippedPaths } : {}) };
  }

  // 5. 分块暂存（只加选中的路径，不碰 zone 外的任何东西）。
  let chunk: string[] = [];
  let chunkBytes = 0;
  const chunks: string[][] = [];
  for (const rel of inZones) {
    const bytes = Buffer.byteLength(rel) + 1;
    if (chunkBytes + bytes > ADD_CHUNK_BYTES && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(rel);
    chunkBytes += bytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  for (const c of chunks) {
    const add = await run("git", ["add", "--", ...c]);
    if (add.code !== 0) {
      return { ok: false, reason: `git add 失败：${tail(add.stderr)}`, ...(skippedPaths.length > 0 ? { skippedPaths } : {}) };
    }
  }

  // 6. commit。仓库没配身份时（CI/新克隆常见）用一次性 -c 补，不碰仓库配置
  //（git config 在拒绝地板里，本模块也绝不写它）。
  let commit = await run("git", ["commit", "-m", input.message]);
  if (commit.code !== 0 && /user\.name|user\.email|tell me who you are/i.test(commit.stderr)) {
    commit = await run("git", ["-c", "user.name=OxCommander", "-c", "user.email=oxcommander@localhost", "commit", "-m", input.message]);
  }
  if (commit.code !== 0) {
    return { ok: false, reason: `git commit 失败：${tail(commit.stderr)}`, ...(skippedPaths.length > 0 ? { skippedPaths } : {}) };
  }

  // 7. 取 commit 号（失败不算失败——分支已成立，短这个号只影响可读性）。
  const head = await run("git", ["rev-parse", "--short", "HEAD"]);
  return {
    ok: true,
    branch: input.branch,
    ...(head.code === 0 ? { commit: head.stdout.trim() } : {}),
    filesCommitted: inZones.length,
    ...(skippedPaths.length > 0 ? { skippedPaths } : {}),
  };
}
