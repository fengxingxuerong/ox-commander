import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "../atomic-file";
import type { ChatSessionSnapshot, ChatSessionSummary } from "../../shared/chat-events";

/**
 * 交互式会话的记录仓（对齐 Codex 的 rollout / resume）。
 *
 * 布局刻意简单：一条会话一个 JSON 文件，索引单独一个原子文件。会话里的
 * `messages` 可能包含文件正文（工具读数），所以不能只存 UI 用的 entries；
 * 恢复时要原样把模型消息接回去，否则恢复后的第一轮会改变协议形状。
 *
 * 失败语义：
 * - 索引坏了 → 扫描 `sessions/` 重建，不丢会话；
 * - 单条会话坏了 → 该条跳过，其它照常列出/恢复；
 * - 写失败 → 抛给宿主，由 IPC 记一条日志；不静默假装已保存。
 */
export const CHAT_SESSION_VERSION = 1;

export interface ChatSessionEnvelope {
  version: typeof CHAT_SESSION_VERSION;
  projectId: string;
  rootAbs: string;
  title: string;
  /** 创建该会话时的主 provider；跨 provider 恢复时只用于诊断。 */
  providerId: string;
  snapshot: ChatSessionSnapshot;
}

interface ChatIndex {
  version: typeof CHAT_SESSION_VERSION;
  sessions: ChatSessionSummary[];
}

const SESSION_ID_RE = /^chat-[A-Za-z0-9-]+$/;

function summaryOf(env: ChatSessionEnvelope): ChatSessionSummary {
  return {
    sessionId: env.snapshot.meta.sessionId,
    projectId: env.projectId,
    title: env.title,
    startedAt: env.snapshot.meta.startedAt,
    updatedAt: env.snapshot.meta.updatedAt,
    status: env.snapshot.meta.status,
    turns: env.snapshot.meta.turns,
    usageTokens: env.snapshot.meta.usageTokens,
  };
}

function titleOf(snapshot: ChatSessionSnapshot): string {
  const first = snapshot.entries.find((e) => e.kind === "user" && e.text.trim() !== "");
  const text = (first?.text ?? "新会话").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function isSnapshot(value: unknown): value is ChatSessionSnapshot {
  // optional chaining 同时处理 null / undefined / 原始值：不先做类型早退，
  // 后续的字段判定本来就会把它们全部判 false。少一层永远等价的守卫。
  const s = value as Partial<ChatSessionSnapshot> | null | undefined;
  return (
    typeof s?.meta === "object" &&
    s?.meta !== null &&
    typeof s?.meta?.sessionId === "string" &&
    Array.isArray(s?.entries) &&
    Array.isArray(s?.messages) &&
    (s?.toolProtocol === "native" || s?.toolProtocol === "text")
  );
}

function isEnvelope(value: unknown): value is ChatSessionEnvelope {
  const e = value as Partial<ChatSessionEnvelope> | null | undefined;
  return (
    e?.version === CHAT_SESSION_VERSION &&
    typeof e?.projectId === "string" &&
    typeof e?.rootAbs === "string" &&
    typeof e?.title === "string" &&
    typeof e?.providerId === "string" &&
    isSnapshot(e?.snapshot)
  );
}

export class ChatSessionStore {
  private readonly dirAbs: string;
  private readonly sessionsAbs: string;
  private readonly indexPath: string;

  constructor(rootAbs: string) {
    this.dirAbs = path.resolve(rootAbs);
    this.sessionsAbs = path.join(this.dirAbs, "sessions");
    this.indexPath = path.join(this.dirAbs, "index.json");
  }

  private sessionPath(sessionId: string): string | null {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    return path.join(this.sessionsAbs, `${sessionId}.json`);
  }

  load(sessionId: string): ChatSessionEnvelope | null {
    const file = this.sessionPath(sessionId);
    if (!file) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return isEnvelope(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  list(projectId?: string): ChatSessionSummary[] {
    const index = this.readIndex() ?? this.rebuildIndex();
    return index.sessions
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt);
  }

  latest(projectId: string): ChatSessionSummary | undefined {
    return this.list(projectId)[0];
  }

  save(
    projectId: string,
    rootAbs: string,
    providerId: string,
    snapshot: ChatSessionSnapshot,
    titleOverride?: string,
  ): ChatSessionEnvelope {
    const env: ChatSessionEnvelope = {
      version: CHAT_SESSION_VERSION,
      projectId,
      rootAbs,
      title: titleOverride ?? titleOf(snapshot),
      providerId,
      snapshot,
    };
    const file = this.sessionPath(snapshot.meta.sessionId);
    if (!file) throw new Error(`非法会话 id：${snapshot.meta.sessionId}`);
    fs.mkdirSync(this.sessionsAbs, { recursive: true });
    writeFileAtomic(file, JSON.stringify(env));
    // 索引缺席时先扫盘重建，不能直接拿空表覆盖 —— 那会让同目录里已有的
    // 其它会话从列表里消失（文件还在，但用户看不到）。
    const index = this.readIndex() ?? this.rebuildIndex();
    const rest = index.sessions.filter((s) => s.sessionId !== snapshot.meta.sessionId);
    index.sessions = [summaryOf(env), ...rest];
    writeFileAtomic(this.indexPath, JSON.stringify(index));
    return env;
  }

  delete(sessionId: string): boolean {
    const file = this.sessionPath(sessionId);
    if (!file) return false;
    // `rmSync(..., {force:true})` 对不存在的路径是 no-op 而不抛错；不先看存在性
    // 就会把"本来就没有"报成"删除成功"，界面对一个不存在的会话显示成功。
    if (!fs.existsSync(file)) return false;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return false;
    }
    const index = this.readIndex();
    if (index) {
      index.sessions = index.sessions.filter((s) => s.sessionId !== sessionId);
      writeFileAtomic(this.indexPath, JSON.stringify(index));
    }
    return true;
  }

  fork(sessionId: string): ChatSessionEnvelope | null {
    const source = this.load(sessionId);
    if (!source) return null;
    const now = Date.now();
    const forked: ChatSessionEnvelope = {
      ...source,
      title: `${source.title}（分叉）`.slice(0, 80),
      snapshot: {
        ...source.snapshot,
        meta: {
          ...source.snapshot.meta,
          sessionId: `chat-${randomUUID()}`,
          startedAt: now,
          updatedAt: now,
          status: "idle",
        },
        entries: source.snapshot.entries.map((e) => ({ ...e })),
        messages: source.snapshot.messages.map((m) => ({ ...m })),
      },
    };
    return this.save(forked.projectId, forked.rootAbs, forked.providerId, forked.snapshot, forked.title);
  }

  private readIndex(): ChatIndex | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      const idx = parsed as Partial<ChatIndex> | null | undefined;
      // 版本与 sessions 形状是唯一判据；null / 原始值在 optional chaining 下
      // 自然落到 `undefined !== 1`，不需要单独的 typeof 守卫。
      if (idx?.version !== CHAT_SESSION_VERSION || !Array.isArray(idx?.sessions)) return null;
      return idx as ChatIndex;
    } catch {
      return null;
    }
  }

  private rebuildIndex(): ChatIndex {
    const sessions: ChatSessionSummary[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.sessionsAbs).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const env = this.load(name.slice(0, -".json".length));
      if (env) sessions.push(summaryOf(env));
    }
    const index: ChatIndex = { version: CHAT_SESSION_VERSION, sessions };
    try {
      if (sessions.length > 0) writeFileAtomic(this.indexPath, JSON.stringify(index));
    } catch {
      // 索引重建是尽力而为；会话文件本身仍能被逐个 load 到。
    }
    return index;
  }
}
