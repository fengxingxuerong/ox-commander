/**
 * 执行器自动探测（竞品缺口 C6：接入摩擦最大项）。
 *
 * 此前接入外部执行器的第一步是**手写 JSON manifest** —— 而项目自己 ship 的
 * `agents.d/*.example.json` 里已经躺着一份份带实测参数的模板。本模块把
 * "扫 PATH 看装了没" 与 "没装给安装命令" 补上，让接入退化成一次点击。
 *
 * ⚠️ **候选表与 `agents.d/*.example.json` 同源**：
 * `src/cli-detect.test.ts` 里有一条守卫逐条比对两者的 `id` / `command` /
 * `entry.argsTemplate`（它读真文件）。改模板必须先改这里，否则红的是那条守卫 ——
 * 那是刻意的设计：**两处事实源必须有一处被钉住**，否则用户照着界面接入的
 * manifest 会与仓库里那份悄悄漂移。
 *
 * ⚠️ **installHint 里的安装命令必须是核实过的**：
 * 2026-10-17 查官方文档 / npm 包页逐条确认（claude / codex / aider / gemini）。
 * 没核实的一律不给命令（goose 那一条就是这么写的）—— 一句装不上的安装命令
 * 比"没提示"更糟，用户会照着它排查半天。
 */
import fs from "node:fs";
import { exampleManifest } from "./manifest-schema";
import {
  resolveOnPath,
  splitPathEnv,
  type CliCandidate,
  type DetectedCli,
} from "../../shared/cli-detect";

/**
 * 安装提示（2026-10-17 逐条核实于官方文档 / npm 包页）：
 * claude-code → npm 包页 @anthropic-ai/claude-code；codex → OpenAI Codex CLI 文档 +
 * npm 包页 @openai/codex；aider → aider 官方安装文档（pipx / pip 两途）；
 * gemini → npm 包页 @google/gemini-cli。goose 的是脚本安装且逐版本会变，
 * **没核实就不给命令** —— 一句装不上的安装命令比没有提示更糟。
 * qwen-code → 2026-10-25 核实于 QwenLM/qwen-code 官方 README
 * （`npm install -g @qwen-code/qwen-code@latest`，无头形态 `qwen -p "..."`）。
 */
const INSTALL_HINTS: Record<string, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex-cli": "npm i -g @openai/codex",
  "aider": "pipx install aider-chat",
  "gemini-cli": "npm i -g @google/gemini-cli",
  "goose": "官方安装脚本见 Block goose 文档（本项目未逐字核实，故不给出命令）",
  "qwen-code": "npm i -g @qwen-code/qwen-code",
};

export const CANDIDATES: readonly CliCandidate[] = [
  {
    id: "claude-code",
    displayName: "Claude Code（本机 CLI）",
    command: "claude",
    installHint: INSTALL_HINTS["claude-code"]!,
    // 逐字取自 agents.d/claude-code.example.json（守卫测试逐条比对 argsTemplate）
    manifest:       {
        "id": "claude-code",
        "displayName": "Claude Code（本机 CLI）",
        "adapter": "cli",
        "entry": {
          "kind": "cli",
          "command": "claude",
          "argsTemplate": [
            "-p",
            "请严格执行文件 {{promptPath}} 中描述的任务（先读该文件，它是完整任务书）。只修改 zone「{{zone}}」内的文件。完成后直接结束。",
            "--dangerously-skip-permissions"
          ],
          "probeArgs": [
            "--version"
          ]
        },
        "capabilities": {
          "protocolVersion": "ox-agent/2",
          "roles": [
            "*"
          ],
          "zoneGlobs": [
            "src",
            "src/**"
          ],
          "supports": [
            "read",
            "edit",
            "create",
            "run-test",
            "review"
          ],
          "artifactKinds": [
            "files",
            "logs",
            "diff"
          ],
          "maxConcurrency": 1,
          "selfIsolated": false
        },
        "credential": {
          "kind": "none"
        },
        "limits": {
          "runDeadlineMs": 900000,
          "idleTimeoutMs": 180000,
          "maxStdoutBytes": 2097152
        },
        "priority": 30,
        "enabled": true
      } as Record<string, unknown>,
  },
  {
    id: "aider",
    displayName: "Aider（本机 CLI）",
    command: "aider",
    installHint: INSTALL_HINTS["aider"]!,
    // 逐字取自 agents.d/aider.example.json（守卫测试逐条比对 argsTemplate）
    manifest:       {
        "id": "aider",
        "displayName": "Aider（本机 CLI）",
        "adapter": "cli",
        "entry": {
          "kind": "cli",
          "command": "aider",
          "argsTemplate": [
            "--message",
            "请严格执行文件 {{promptPath}} 中描述的任务（先读该文件，它是完整任务书）。只修改 zone「{{zone}}」内的文件。完成后直接结束。",
            "--yes-always",
            "--no-pretty"
          ],
          "probeArgs": [
            "--version"
          ]
        },
        "capabilities": {
          "protocolVersion": "ox-agent/2",
          "roles": [
            "*"
          ],
          "zoneGlobs": [
            "src",
            "src/**"
          ],
          "supports": [
            "read",
            "edit",
            "create",
            "run-test"
          ],
          "artifactKinds": [
            "files",
            "diff"
          ],
          "maxConcurrency": 1,
          "selfIsolated": false
        },
        "credential": {
          "kind": "none"
        },
        "limits": {
          "runDeadlineMs": 900000,
          "idleTimeoutMs": 180000,
          "maxStdoutBytes": 2097152
        },
        "priority": 20,
        "enabled": true
      } as Record<string, unknown>,
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI（Google，本机 CLI）",
    command: "gemini",
    installHint: INSTALL_HINTS["gemini-cli"]!,
    // 逐字取自 agents.d/gemini-cli.example.json（守卫测试逐条比对 argsTemplate）
    manifest:       {
        "id": "gemini-cli",
        "displayName": "Gemini CLI（Google，本机 CLI）",
        "adapter": "cli",
        "entry": {
          "kind": "cli",
          "command": "gemini",
          "argsTemplate": [
            "-p",
            "请严格执行文件 {{promptPath}} 中描述的任务（先读该文件，它是完整任务书）。只修改 zone「{{zone}}」内的文件。完成后直接结束。",
            "--yolo"
          ],
          "probeArgs": [
            "--version"
          ]
        },
        "capabilities": {
          "protocolVersion": "ox-agent/2",
          "roles": [
            "*"
          ],
          "zoneGlobs": [
            "src",
            "src/**"
          ],
          "supports": [
            "read",
            "edit",
            "create",
            "run-test"
          ],
          "artifactKinds": [
            "files",
            "diff"
          ],
          "maxConcurrency": 1,
          "selfIsolated": false
        },
        "credential": {
          "kind": "none"
        },
        "limits": {
          "runDeadlineMs": 900000,
          "idleTimeoutMs": 180000,
          "maxStdoutBytes": 2097152
        },
        "priority": 20,
        "enabled": true
      } as Record<string, unknown>,
  },
  {
    id: "goose",
    displayName: "Goose（Block，本机 CLI）",
    command: "goose",
    installHint: INSTALL_HINTS["goose"]!,
    // 逐字取自 agents.d/goose.example.json（守卫测试逐条比对 argsTemplate）
    manifest:       {
        "id": "goose",
        "displayName": "Goose（Block，本机 CLI）",
        "adapter": "cli",
        "entry": {
          "kind": "cli",
          "command": "goose",
          "argsTemplate": [
            "run",
            "--text",
            "请严格执行文件 {{promptPath}} 中描述的任务（先读该文件，它是完整任务书）。只修改 zone「{{zone}}」内的文件。完成后直接结束。",
            "--no-session"
          ],
          "probeArgs": [
            "--version"
          ]
        },
        "capabilities": {
          "protocolVersion": "ox-agent/2",
          "roles": [
            "*"
          ],
          "zoneGlobs": [
            "src",
            "src/**"
          ],
          "supports": [
            "read",
            "edit",
            "create",
            "run-test"
          ],
          "artifactKinds": [
            "files",
            "logs"
          ],
          "maxConcurrency": 1,
          "selfIsolated": false
        },
        "credential": {
          "kind": "none"
        },
        "limits": {
          "runDeadlineMs": 900000,
          "idleTimeoutMs": 180000,
          "maxStdoutBytes": 2097152
        },
        "priority": 20,
        "enabled": true
      } as Record<string, unknown>,
  },
  {
    id: "codex-cli",
    displayName: "Codex CLI",
    command: "codex",
    installHint: INSTALL_HINTS["codex-cli"]!,
    // codex 这份直接复用 `exampleManifest()` —— 它是仓内唯一的 codex
    // 模板（`agents.d/codex.example.json` 与界面「填入示例」共用同一份）。
    manifest: exampleManifest() as unknown as Record<string, unknown>,
  },
  {
    id: "qwen-code",
    displayName: "Qwen Code（本机 CLI）",
    command: "qwen",
    installHint: INSTALL_HINTS["qwen-code"]!,
    // 逐字取自 agents.d/qwen-code.example.json（守卫测试逐条比对 argsTemplate）。
    // 模板随 resilience 提交进仓但一直没接进探测表 —— 2026-10-25 竞品刷新补接线：
    // 无头形态 `qwen -p` 与安装命令 npm 包 @qwen-code/qwen-code 均核实于官方 README。
    manifest:       {
        "id": "qwen-code",
        "displayName": "Qwen Code（本机 CLI）",
        "adapter": "cli",
        "entry": {
          "kind": "cli",
          "command": "qwen",
          "argsTemplate": [
            "-p",
            "请严格执行文件 {{promptPath}} 中描述的任务（先读该文件，它是完整任务书）。只修改 zone「{{zone}}」内的文件。完成后直接结束。",
            "--yolo"
          ],
          "probeArgs": [
            "--version"
          ]
        },
        "capabilities": {
          "protocolVersion": "ox-agent/2",
          "roles": [
            "*"
          ],
          "zoneGlobs": [
            "src",
            "src/**"
          ],
          "supports": [
            "read",
            "edit",
            "create",
            "run-test"
          ],
          "artifactKinds": [
            "files",
            "diff"
          ],
          "maxConcurrency": 1,
          "selfIsolated": false
        },
        "credential": {
          "kind": "none"
        },
        "limits": {
          "runDeadlineMs": 900000,
          "idleTimeoutMs": 180000,
          "maxStdoutBytes": 2097152
        },
        "priority": 20,
        "enabled": true
      } as Record<string, unknown>,
  },
];

export interface DetectOptions {
  /** PATH 环境变量（可注入，测试用临时目录）。 */
  pathEnv?: string;
  /** 已注册的执行器 id（接入按钮据此不再出现）。 */
  registeredIds?: ReadonlySet<string>;
  /** 平台（可注入，测试造 Windows 形态）。 */
  isWindows?: boolean;
}

/**
 * 扫 PATH 出候选（不 spawn 任何进程）。
 *
 * 读不到 PATH（环境里没有）时**全部按未找到**返回，而不是抛 ——
 * 探测是给人看结果的，不是交付条件；界面会照常把安装提示摆出来。
 */
export function detectInstalledClis(opts: DetectOptions = {}): DetectedCli[] {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const isWindows = opts.isWindows ?? process.platform === "win32";
  const dirs = splitPathEnv(pathEnv, isWindows);
  const registered = opts.registeredIds ?? new Set<string>();
  // 不套 try/catch：`fs.existsSync` 的契约就是"异常一律折成 false"（它的
  // 实现自己 catch），所以那层 catch 是本函数里永远走不到的死分支 —— 留着
  // 只是给变异门禁贡献一个杀不掉的位点。
  const exists = (abs: string): boolean => fs.existsSync(abs);

  return CANDIDATES.map((c) => {
    const abs = resolveOnPath(c.command, dirs, exists, isWindows);
    return {
      id: c.id,
      displayName: c.displayName,
      command: c.command,
      found: abs !== null,
      ...(abs !== null ? { absPath: abs } : {}),
      installHint: c.installHint,
      registered: registered.has(c.id),
      manifest: c.manifest,
    };
  });
}
