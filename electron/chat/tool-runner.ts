import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { DEFAULT_SKIP_DIRS } from "../sandbox/file-journal";
import { PathPolicy } from "../sandbox/path-policy";
import { CommandPolicy, createDefaultCommandPolicy } from "../sandbox/command-policy";
import { planSpawn } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";
import { scopedEnv } from "../agents/scoped-env";
import { writeFileAtomic } from "../atomic-file";
import { matchesAnyGlob } from "../../shared/glob";
import { truncateToolOutput, type ChatFileChange, type ToolCall, type ToolResult } from "../../shared/tools/spec";
import { parsePatch, applyFileOp, describePatchOps } from "../../shared/tools/patch";
import {
  assertKnownTool,
  baseNameOf,
  decideTool,
  unknownToolReason,
  type ApprovalPolicy,
  type SandboxMode,
} from "../../shared/tools/policy";
import type { ChatApprovalAnswer, ChatApprovalRequest } from "../../shared/chat-events";
import type { Skill } from "../../shared/skills";

/** 目录项排序的唯一实现：walk 用它，测试直接对合成数组断言。 */
export function compareEntryNames(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 工具执行层：把模型的一次工具调用变成一次**受约束的**真实动作。
 *
 * 每一条工具都落在既有沙箱之内，而不是另起一套判定：
 * - 读：`PathPolicy.assertReadable`（此前生产零调用，这里接上）；
 * - 写：`PathPolicy.assertWritable`（与内置执行器同一个七级判定）；
 * - 命令：`CommandPolicy` + `planSpawn` + `killTree`（与验证链同一道地板）。
 *
 * 为什么工具层要自己再判一次而不是"信任模型"：模型给出的路径来自它自己的
 * 理解，而它的理解来自上一轮工具输出 —— 一次读错了，下一次写就照着错的写。
 * 沙箱在这里的价值不是防恶意，是防**漂移**。
 */
import { conflictFacts, describeConflictFacts, type ConflictFact, type ThreadWrite } from "../../shared/chat-conflict";

export interface ToolRunnerOptions {
  /** 项目根：一切路径判定的边界。 */
  rootAbs: string;
  pathPolicy?: PathPolicy;
  commandPolicy?: CommandPolicy;
  mode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalCommands?: readonly string[];
  /**
   * 审批回调（宿主注入：桌面走 IPC，headless/测试直接给一个函数）。
   * **缺席 = 需要审批的动作一律按拒绝处理**（fail-closed，与 `ApprovalGate`
   * 同一条纪律，见 `electron/sandbox/approval-gate.ts` 头注释）。
   */
  requestApproval?: (req: ChatApprovalRequest) => Promise<ChatApprovalAnswer>;
  onEvent?: (text: string) => void;
  /** 单条命令的硬超时（毫秒）。 */
  commandTimeoutMs?: number;
  /** 单个文件读取的字节上限。 */
  maxFileBytes?: number;
  /** 检索时最多看多少个文件（大仓库防跑飞）。 */
  maxSearchFiles?: number;
  /** 读文件正文的注入点（默认 fs.readFileSync）；测试用来构造读失败分支。 */
  readTextFile?: (abs: string) => string;
  /**
   * 本线程 id（M4c）。缺席 = 不做并行冲突检测（CLI / headless 单线程形态）。
   */
  sessionId?: string;
  /**
   * 别的活跃线程的写记录（M4c）。缺席 = 不做冲突检测。
   *
   * 用**函数**而不是数组：台账在主进程里随时在长，注入点要读的是"此刻"。
   */
  conflictWrites?: () => readonly ThreadWrite[];
  /** 冲突窗口（毫秒）；默认见 `DEFAULT_CONFLICT_WINDOW_MS`。 */
  conflictWindowMs?: number;
  /** 写成功后回灌台账（M4c）：让别的线程知道"这个文件刚被改过"。 */
  onWrite?: (paths: readonly string[]) => void;
  /**
   * 会话技能（M6b）：read_skill 的名字就绪表，与提示里的目录块**同一次扫描**的产物
   * —— 模型给的 name 只在这张表里查，永远不参与路径拼接，能读到的只能是扫描层
   * 见过的那几份。缺席 = 本会话没有技能可读（一律报「没有这个技能」）。
   * 停用项也在表里：停用的要点名拒绝，而不是装作不存在。
   */
  skills?: readonly Skill[];
  /**
   * 全局技能目录根（绝对路径）。全局技能在项目外，`pathPolicy` 管不到它 ——
   * read_skill 对全局技能以这个根为界再走一次同一个 `PathPolicy` 判定
   * （相对根解析 + realpath 包含 + 禁读地板；**不吃**项目的 policy.d 覆盖，
   * 那份管的是项目根，不该越界裁全局目录）。缺席 = 全局技能一律不可读。
   */
  skillGlobalRootAbs?: string;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAX_SEARCH_FILES = 2_000;
/** 命令输出字节上限（与 verifier 的 2MiB 口径一致）。 */
export const COMMAND_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export class ToolRunner {
  private readonly rootAbs: string;
  private readonly pathPolicy: PathPolicy;
  private readonly commandPolicy: CommandPolicy;
  private readonly mode: SandboxMode;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly approvalCommands: readonly string[];
  private readonly requestApproval?: (req: ChatApprovalRequest) => Promise<ChatApprovalAnswer>;
  private readonly onEvent?: (text: string) => void;
  private readonly commandTimeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly maxSearchFiles: number;
  private readonly readTextFile: (abs: string) => string;
  private readonly sessionId?: string;
  private readonly conflictWrites?: () => readonly ThreadWrite[];
  private readonly conflictWindowMs?: number;
  private readonly onWrite?: (paths: readonly string[]) => void;
  /** M6b：read_skill 的名字就绪表（含停用项）。 */
  private readonly skills: readonly Skill[];
  /** M6b：全局技能根（原始路径）与以它为界的读判定；缺席 = 全局技能不可读。 */
  private readonly skillGlobal?: { rootAbs: string; policy: PathPolicy };
  /** 本次会话里人答过"不用再问"的动作（key 由 policy 层定义）。 */
  private readonly sessionApproved = new Set<string>();

  constructor(opts: ToolRunnerOptions) {
    this.rootAbs = opts.rootAbs;
    this.pathPolicy = opts.pathPolicy ?? new PathPolicy({ projectRoot: opts.rootAbs });
    this.commandPolicy = opts.commandPolicy ?? createDefaultCommandPolicy();
    this.mode = opts.mode ?? "workspace-write";
    this.approvalPolicy = opts.approvalPolicy ?? "on-request";
    this.approvalCommands = opts.approvalCommands ?? [];
    this.requestApproval = opts.requestApproval;
    if (opts.onEvent) this.onEvent = opts.onEvent;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxSearchFiles = opts.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES;
    this.readTextFile = opts.readTextFile ?? ((abs) => fs.readFileSync(abs, "utf8"));
    this.sessionId = opts.sessionId;
    this.conflictWrites = opts.conflictWrites;
    this.conflictWindowMs = opts.conflictWindowMs;
    this.onWrite = opts.onWrite;
    this.skills = opts.skills ?? [];
    // 原始根与它的读判定收成一个字段：两者同生同灭，只留一处可判"缺席"。
    // 相对路径必须按**原始根**算 —— `PathPolicy.projectRoot` 是 realpath 后的长名，
    // 而扫描层给的 `skill.path` 走的是调用方传入的原始根，win32 的 8.3 短名
    // (`ADMINI~1`) 在两者之间会让 `path.relative` 算出一串 `..`。
    this.skillGlobal = opts.skillGlobalRootAbs
      ? { rootAbs: opts.skillGlobalRootAbs, policy: new PathPolicy({ projectRoot: opts.skillGlobalRootAbs }) }
      : undefined;
  }

  /**
   * 执行一个工具调用。
   *
   * 永不抛错：所有失败都变成 `ok: false` 且带**给模型看**的 `reason` ——
   * 工具失败是模型下一轮的输入，抛异常则整轮会话崩掉，而"读一个不存在的文件"
   * 这种事一天会发生几十次。
   */
  async run(call: ToolCall, opts: { signal?: AbortSignal; turn?: number } = {}): Promise<ToolResult> {
    try {
      return await this.dispatch(call, opts.signal, opts.turn);
    } catch (e) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: (e as Error).message };
    }
  }

  private async dispatch(call: ToolCall, signal?: AbortSignal, turn?: number): Promise<ToolResult> {
    // 名字先过闸：`call.name` 可能来自端点响应（原生 tools 路径），端点可以返回
    // 任意字符串；在 switch 里落到 default 等于"未知工具按已知工具处理"。
    if (assertKnownTool(call.name) === null) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: unknownToolReason(call.name) };
    }
    switch (call.name) {
      case "read_file":
        return this.readFile(call);
      case "list_dir":
        return this.listDir(call);
      case "grep_files":
        return this.grepFiles(call);
      case "find_by_name":
        return this.findByName(call);
      case "apply_patch":
        return this.applyPatch(call, signal, turn);
      case "run_command":
        return this.runCommand(call, signal);
      case "read_skill":
        return this.readSkill(call);
      default:
        return { id: call.id, name: call.name, ok: false, output: "", reason: `未实现的工具：${String(call.name)}` };
    }
  }

  private absOf(rel: string): string {
    return path.resolve(this.rootAbs, rel);
  }

  private ok(call: ToolCall, output: string): ToolResult {
    const cut = truncateToolOutput(output);
    return {
      id: call.id,
      name: call.name,
      ok: true,
      output: cut.text,
      ...(cut.truncatedFrom ? { truncatedFrom: cut.truncatedFrom } : {}),
    };
  }

  /** 写与执行之前的统一裁决：沙箱档位 → 会话记忆 → 审批策略。 */
  private async guard(
    call: ToolCall,
    extra: { command?: string; paths?: readonly string[] },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const decision = decideTool({
      tool: call.name,
      mode: this.mode,
      approvalPolicy: this.approvalPolicy,
      approvalCommands: this.approvalCommands,
      ...(extra.command ? { command: extra.command } : {}),
      sessionApproved: [...this.sessionApproved],
    });
    if (decision.verdict === "deny") return { ok: false, reason: decision.reason };
    if (decision.verdict === "allow") return { ok: true };

    if (!this.requestApproval) {
      return {
        ok: false,
        reason: `需要人工确认（${decision.reason}），但当前没有审批通道，按拒绝处理`,
      };
    }
    let answer: ChatApprovalAnswer;
    try {
      answer = await this.requestApproval({
        requestId: call.id,
        tool: call.name === "run_command" ? "run_command" : "apply_patch",
        reason: decision.reason,
        ...(extra.command ? { command: extra.command } : {}),
        ...(call.name === "run_command" ? { args: this.argsOf(call) } : {}),
        ...(extra.paths ? { paths: extra.paths } : {}),
      });
    } catch (e) {
      // 审批回调炸了按拒绝处理，不把异常当成默许。
      return { ok: false, reason: `审批通道出错，按拒绝处理：${(e as Error).message}` };
    }
    if (!answer.granted) {
      return {
        ok: false,
        reason: answer.reason ? `人工拒绝：${answer.reason}` : "人工拒绝了该操作（未说明理由）",
      };
    }
    if (answer.scope === "session") {
      const key =
        call.name === "run_command" ? `cmd:${baseNameOf(extra.command ?? "")}` : `tool:${call.name}`;
      this.sessionApproved.add(key);
    }
    return { ok: true };
  }

  /**
   * 查并行冲突（M4c · P1）。
   *
   * 两个注入点都给了才检测：`sessionId` 缺席（CLI / headless 单线程）时没有
   * "别人"这回事，跑了只会把自己的历史当冲突拦自己一次。
   */
  private detectConflicts(paths: readonly string[]): ConflictFact[] {
    if (this.sessionId === undefined || this.conflictWrites === undefined) return [];
    return conflictFacts(paths, this.conflictWrites(), {
      sessionId: this.sessionId,
      now: Date.now(),
      ...(this.conflictWindowMs !== undefined ? { windowMs: this.conflictWindowMs } : {}),
    });
  }

  /**
   * 冲突的那一问。
   *
   * 与 `guard` 的三点不同，都是刻意的：
   * 1. **不接"本次会话不再问"**。一次冲突是一次具体的事实（"谁刚改过"），
   *    记住它等于把闸门永久关上 —— P1 的价值全在"每次都让人看一眼"。
   * 2. **没有审批通道就按拒绝**（fail-closed，与 `guard` 同纪律）：没有通道
   *    时放行，等于这个保护根本不存在。
   * 3. 请求 id 带 `conflict-` 前缀：它和同一次调用的 `guard` 审批是两个不同的
   *    问题，共用一个 id 会让第二次提问被第一个答复吃掉。
   */
  private async confirmConflict(
    call: ToolCall,
    facts: readonly ConflictFact[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const reason = describeConflictFacts(facts);
    if (!this.requestApproval) {
      return { ok: false, reason: `${reason} 当前没有审批通道，按拒绝处理` };
    }
    let answer: ChatApprovalAnswer;
    try {
      answer = await this.requestApproval({
        requestId: `conflict-${call.id}`,
        tool: "apply_patch",
        reason,
        paths: facts.map((f) => f.path),
      });
    } catch (e) {
      return { ok: false, reason: `审批通道出错，按拒绝处理：${(e as Error).message}` };
    }
    if (!answer.granted) {
      return {
        ok: false,
        reason: answer.reason ? `人工拒绝：${answer.reason}` : "人工拒绝了这次冲突写入（未说明理由）",
      };
    }
    return { ok: true };
  }

  private argsOf(call: ToolCall): string[] {
    const raw = call.args.args;
    return Array.isArray(raw) ? raw.map((a) => String(a)) : [];
  }

  private readFile(call: ToolCall): ToolResult {
    const rel = String(call.args.path ?? "");
    if (!this.pathPolicy.assertReadable(rel)) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `不允许读取该路径：${rel}` };
    }
    const abs = this.absOf(rel);
    if (!fs.existsSync(abs)) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `文件不存在：${rel}` };
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `不是文件：${rel}` };
    }
    if (stat.size > this.maxFileBytes) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        output: "",
        reason: `文件过大（${stat.size} 字节，上限 ${this.maxFileBytes}）：${rel}`,
      };
    }
    const text = fs.readFileSync(abs, "utf8");
    const maxLines = typeof call.args.maxLines === "number" ? Math.max(1, Math.floor(call.args.maxLines)) : 400;
    const lines = text.split("\n");
    const shown = lines.slice(0, maxLines);
    const numbered = shown.map((l, i) => `${i + 1}: ${l}`).join("\n");
    const tail =
      lines.length > maxLines ? `\n…（共 ${lines.length} 行，只给了前 ${maxLines} 行；可加大 maxLines 或先 grep 定位）` : "";
    return this.ok(call, numbered + tail);
  }

  /**
   * read_skill（M6b）：按名字取技能全文。
   *
   * 安全口径与 `read_file` 同一条判据，**名字永远不参与路径拼接** —— 模型给的
   * name 只在注入的技能表里查，能读到的只能是扫描层见过的那几份：
   * - 项目级：`skill.path` 是相对项目根的 POSIX 路径，直接过 `pathPolicy.assertReadable`
   *   （realpath 后再判禁读地板 —— 技能目录里放一个指向 `.env` 的软链，在 realpath
   *   那一步就现形并被拒）；
   * - 全局级在项目外，`pathPolicy` 管不到：以技能目录根为界再走**同一个** `PathPolicy`
   *   实现（相对根解析 + realpath 包含 + 禁读地板）。刻意不吃项目的 `policy.d` 读覆盖
   *   —— 那份声明管的是项目根，让它越界裁全局目录等于把项目配置升了权。
   */
  private readSkill(call: ToolCall): ToolResult {
    const fail = (reason: string): ToolResult => ({ id: call.id, name: call.name, ok: false, output: "", reason });
    const name = String(call.args.name ?? "").trim();
    if (name === "") return fail("缺少技能名（name）");
    const skill = this.skills.find((s) => s.name === name);
    if (skill === undefined) {
      const known = this.skills.map((s) => s.name).join("、");
      return fail(`没有这个技能：${name}${known === "" ? "（本会话没有可用技能）" : `（可用：${known}）`}`);
    }
    // 停用不等于不存在（shared/skills.ts 的纪律 3）：要点名拒绝，理由里带上停用标记。
    if (!skill.enabled) return fail(`技能已停用（同目录里有 .disabled）：${name}`);
    if (skill.origin === "project") {
      if (!this.pathPolicy.assertReadable(skill.path)) {
        return fail(`不允许读取该技能文件（沙箱判定）：${skill.path}`);
      }
      return this.readSkillFile(call, this.absOf(skill.path), skill.path);
    }
    // 全局根缺席 = 全局技能一律不可读。根与 policy 收在同一个字段里，只判一次 ——
    // 两个分开的可选字段会多出一个"永远同真同假"的分支，位点审计只会把它记成等价。
    const global = this.skillGlobal;
    if (global === undefined) {
      return fail(`全局技能目录在本会话不可用：${name}`);
    }
    if (!global.policy.assertReadable(path.relative(global.rootAbs, skill.path))) {
      return fail(`不允许读取该技能文件（沙箱判定）：${skill.path}`);
    }
    return this.readSkillFile(call, path.resolve(skill.path), skill.path);
  }

  /** 读一份技能文件：与 `readFile` 同一套存在性 / 形态 / 大小检查，只是话术点名「技能」。 */
  private readSkillFile(call: ToolCall, abs: string, shown: string): ToolResult {
    const fail = (reason: string): ToolResult => ({ id: call.id, name: call.name, ok: false, output: "", reason });
    if (!fs.existsSync(abs)) {
      return fail(`技能文件不存在（会话开始后可能被删除）：${shown}`);
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return fail(`技能文件不是文件：${shown}`);
    }
    if (stat.size > this.maxFileBytes) {
      return fail(`技能文件过大（${stat.size} 字节，上限 ${this.maxFileBytes}）：${shown}`);
    }
    return this.ok(call, this.readTextFile(abs));
  }

  /** 递归列目录（只走项目内，跳过构建产物目录）。 */
  private walk(relDir: string, depth: number, out: string[], filesOnly: boolean): void {
    const abs = relDir === "" ? this.rootAbs : this.absOf(relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // 固定顺序：命令与 grep 的"先遇到谁"会影响输出与上限截断；readdir 的
    // 原生顺序在不同文件系统上不一致，测试与模型看到的结果都会漂。
    entries.sort(compareEntryNames);
    for (const e of entries) {
      const childRel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      // 目录项也要过读判定：Windows junction 在 dirent 里可能报成目录，
      // 只按名字拼接再递归会直接穿出项目根。realpath 在这里逐项做一次，
      // 上限 2000 个文件，代价可接受，换来的是"列目录也不能看见外部"。
      if (!this.pathPolicy.assertReadable(childRel)) continue;
      if (e.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(e.name)) continue;
        if (!filesOnly) out.push(`${childRel}/`);
        if (depth > 1 && out.length < this.maxSearchFiles) this.walk(childRel, depth - 1, out, filesOnly);
      } else if (e.isFile()) {
        out.push(childRel);
      }
      if (out.length >= this.maxSearchFiles) return;
    }
  }

  private listDir(call: ToolCall): ToolResult {
    const rel = String(call.args.path ?? "").replace(/^\/+/, "");
    if (rel !== "" && !this.pathPolicy.assertReadable(rel)) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `不允许访问该路径：${rel}` };
    }
    const depth = typeof call.args.depth === "number" ? Math.min(3, Math.max(1, Math.floor(call.args.depth))) : 1;
    const out: string[] = [];
    this.walk(rel, depth, out, false);
    if (out.length === 0) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `目录为空或不存在：${rel || "."}` };
    }
    const capped = out.length >= this.maxSearchFiles ? `\n…（达到 ${this.maxSearchFiles} 条上限，请缩小目录范围）` : "";
    return this.ok(call, out.join("\n") + capped);
  }

  private grepFiles(call: ToolCall): ToolResult {
    const pattern = String(call.args.pattern ?? "");
    if (pattern === "") {
      return { id: call.id, name: call.name, ok: false, output: "", reason: "缺少检索正则" };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `正则无法编译：${(e as Error).message}` };
    }
    const scope = String(call.args.path ?? "").replace(/^\/+/, "");
    const maxMatches = typeof call.args.maxMatches === "number" ? Math.max(1, Math.floor(call.args.maxMatches)) : 40;
    const files: string[] = [];
    this.walk(scope, 8, files, true);
    const hits: string[] = [];
    let scanned = 0;
    for (const rel of files) {
      if (hits.length >= maxMatches) break;
      scanned += 1;
      const abs = this.absOf(rel);
      let text: string;
      try {
        if (fs.statSync(abs).size > this.maxFileBytes) continue;
        text = this.readTextFile(abs);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
        if (hits.length >= maxMatches) break;
      }
    }
    if (hits.length === 0) {
      return this.ok(call, `没有命中（扫了 ${scanned} 个文件）。可放宽正则或换 find_by_name 先定位文件。`);
    }
    const capped = hits.length >= maxMatches ? `\n…（达到 ${maxMatches} 条上限，可加大 maxMatches）` : "";
    return this.ok(call, hits.join("\n") + capped);
  }

  private findByName(call: ToolCall): ToolResult {
    const pattern = String(call.args.glob ?? "");
    if (pattern === "") {
      return { id: call.id, name: call.name, ok: false, output: "", reason: "缺少文件名 glob" };
    }
    const scope = String(call.args.path ?? "").replace(/^\/+/, "");
    const all: string[] = [];
    this.walk(scope, 8, all, true);
    const hits = all.filter((rel) => matchesAnyGlob(rel, [pattern]));
    if (hits.length === 0) {
      return this.ok(call, `没有命中（扫了 ${all.length} 个文件）`);
    }
    return this.ok(call, hits.join("\n"));
  }

  private async applyPatch(call: ToolCall, signal?: AbortSignal, turn = 0): Promise<ToolResult> {
    if (signal?.aborted) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: "会话已中止，补丁未应用" };
    }
    const parsed = parsePatch(String(call.args.patch ?? ""));
    if ("error" in parsed) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: `补丁无法解析：${parsed.error}` };
    }
    const paths = parsed.ops.map((op) => op.path);
    // 并行冲突（M4c · P1）：写之前先问一句"有没有别的线程刚改过这些文件"。
    // 放在 `guard` **之前**：人要先知道"这是别人的地盘"，再决定要不要批这次写 ——
    // 顺序反过来会让审批理由里少掉最关键的那个事实。
    const conflicts = this.detectConflicts(paths);
    if (conflicts.length > 0) {
      const verdict = await this.confirmConflict(call, conflicts);
      if (!verdict.ok) return { id: call.id, name: call.name, ok: false, output: "", reason: verdict.reason };
    }
    const guard = await this.guard(call, { paths });
    if (!guard.ok) return { id: call.id, name: call.name, ok: false, output: "", reason: guard.reason };

    const done: string[] = [];
    const changes: ChatFileChange[] = [];
    const fail = (reason: string): ToolResult => ({
      id: call.id,
      name: call.name,
      ok: false,
      output: done.join("；"),
      reason,
      ...(changes.length > 0 ? { changes } : {}),
    });
    for (const op of parsed.ops) {
      // 多文件补丁在文件之间停下（不假装整份原子）；每个文件内部要么完整写完，
      // 要么在前面就失败并原样返回，不会留下"改了一半"的中间态。
      if (signal?.aborted) return fail("会话已中止，剩余文件未应用");
      // 逐个文件过写入判定：某个文件被拒时不牵连其它文件，审计也能记清楚。
      const decision = this.pathPolicy.assertWritable(op.path);
      if (!decision.ok) return fail(`${op.path}：${decision.reason}`);
      const abs = decision.abs;
      const original = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      const outcome = applyFileOp(op, original);
      if ("error" in outcome) return fail(`${op.path}：${outcome.error}`);
      // 全文进 change 是为了撤销；超过读上限的文件不记正文（否则一份会话
      // 记录可能被一个大文件撑爆），但改动本身仍然落盘，界面标"不可撤销"。
      const tooLarge =
        (original?.length ?? 0) > this.maxFileBytes || (outcome.content?.length ?? 0) > this.maxFileBytes;
      changes.push({
        path: op.path,
        before: tooLarge ? null : original,
        after: tooLarge ? null : outcome.content,
        created: original === null && outcome.content !== null,
        turn,
        revertable: !tooLarge,
      });
      if (outcome.content === null) {
        fs.unlinkSync(abs);
        done.push(`删除 ${op.path}`);
        continue;
      }
      // 原子替换：崩在 flush 中间不会留下半写文件；同目录临时文件 + rename。
      writeFileAtomic(abs, outcome.content);
      done.push(`${op.kind === "add" ? "新建" : "修改"} ${op.path}${outcome.notes.length > 0 ? `（${outcome.notes.join("；")}）` : ""}`);
    }
    this.onEvent?.(`[chat:patch] ${describePatchOps(parsed.ops)}：${paths.join("、")}`);
    // 记进台账：别的线程下一步撞上同一个文件时，人能看到"谁刚动过"。
    this.onWrite?.(paths);
    const result = this.ok(call, `补丁已应用：${done.join("；")}`);
    return changes.length > 0 ? { ...result, changes } : result;
  }

  private async runCommand(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (signal?.aborted) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: "会话已中止，命令未执行" };
    }
    const command = String(call.args.command ?? "");
    const args = this.argsOf(call);
    const policy = this.commandPolicy.check(command, args);
    if (!policy.ok) {
      return { id: call.id, name: call.name, ok: false, output: "", reason: policy.reason };
    }
    const guard = await this.guard(call, { command });
    if (!guard.ok) return { id: call.id, name: call.name, ok: false, output: "", reason: guard.reason };

    const spec = planSpawn(command, args, this.commandPolicy);
    return await new Promise<ToolResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: this.rootAbs,
          // 与验证/冒烟子进程同一条纪律：默认不把宿主的 provider key 交给
          // 模型生成的命令。`scopedEnv()` 只保留运行所需的基础变量，密钥
          // 需要显式授权才会透传（本会话默认没有任何授权）。
          env: scopedEnv(),
          shell: false,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ id: call.id, name: call.name, ok: false, output: "", reason: `无法启动进程：${(e as Error).message}` });
        return;
      }
      let bytes = 0;
      let dropped = 0;
      let chunks = "";
      let settled = false;
      const collect = (buf: Buffer): void => {
        // 超预算后仍要排空管道（否则子进程写满管道会挂死），只是不再累积。
        if (bytes < COMMAND_OUTPUT_MAX_BYTES) {
          const room = COMMAND_OUTPUT_MAX_BYTES - bytes;
          const slice = buf.toString("utf8").slice(0, room);
          chunks += slice;
          bytes += Buffer.byteLength(slice);
          dropped += Math.max(0, buf.length - Buffer.byteLength(slice));
        } else {
          dropped += buf.length;
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        if (settled) return;
        killTree(child);
        finish(false, `命令超时（${this.commandTimeoutMs}ms）被中止：${command} ${args.join(" ")}`);
      }, this.commandTimeoutMs);
      let abortHandler: (() => void) | null = null;
      const finish = (okExit: boolean, reason?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        const tail = dropped > 0 ? `\n…（已丢弃约 ${Math.ceil(dropped / 1024)} KB 输出）` : "";
        const text = `${chunks}${tail}`;
        const cut = truncateToolOutput(text);
        resolve({
          id: call.id,
          name: call.name,
          ok: okExit,
          output: cut.text,
          ...(reason ? { reason } : {}),
          ...(cut.truncatedFrom ? { truncatedFrom: cut.truncatedFrom } : {}),
        });
      };
      if (signal) {
        abortHandler = () => {
          // 先杀进程树再收尾：只 resolve 不 kill 会让命令继续写盘，
          // 用户看到的"已停止"就只是界面停了。
          killTree(child);
          finish(false, `命令被中止（会话停止）：${command} ${args.join(" ")}`);
        };
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
      child.on("error", (e) => finish(false, `进程启动失败：${e.message}`));
      child.on("close", (code) => {
        // 退出码只取自 close 事件：子进程可以用 stdout 伪造"看起来成功"的输出。
        finish(code === 0, code === 0 ? undefined : `命令退出码 ${code}：${command} ${args.join(" ")}`);
      });
    });
  }
}
