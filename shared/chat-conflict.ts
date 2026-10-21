/**
 * 并行写冲突（M4c · P1）。
 *
 * Codex 用 worktree 做**物理隔离**；我们按 D 类决议不走 worktree（会丢掉跨模块
 * 协同与"一份交付物"），所以两条线程改同一个文件时，冲突只能靠**提示 + 人拍板**
 * 解决 —— 这正是会话层"人是最后的仲裁者"与编排层"门禁是仲裁者"的分界。
 *
 * 判据刻意做成纯函数：它决定的是"要不要拦一下人"，而拦错了（该拦不拦、不该拦
 * 乱拦）都不会抛异常，只会表现为一次莫名其妙的补丁覆盖或一次烦人的弹窗。
 *
 * 三条纪律：
 * 1. **只认别人的写**。自己这条线程刚改过的文件再改一次是最常见的正常动作
 *    （补丁打一半、模型接着补），把它算成冲突等于给自己的手绑住。
 * 2. **每条路径只报最近那一次**。三条线程都改过同一个文件时，人要看的是
 *    "谁刚动过"，不是一份流水账。
 * 3. **边界属于"该拦"**：时间窗外的写不算冲突（陈旧线索没有价值），
 *    时钟倒挂（`ts > now`）按"刚刚"处理 —— 宁可多问一次，也不要因为两个
 *    时钟不一致把真正的并发写放过去。
 *
 * 刻意不做：同项目写串行闸（P3，已裁决不做）、越界回滚（编排侧 BatchGuard
 * 的硬回滚是另一种判据，会话层**只提示不回滚**）。
 */
/** 一次落盘的写记录（宿主按线程维护，只保留活跃线程的）。 */
export interface ThreadWrite {
  sessionId: string;
  path: string;
  /** 写入时刻（宿主时钟，毫秒）。 */
  ts: number;
}

/** 一条待写路径上的冲突事实。 */
export interface ConflictFact {
  path: string;
  /** 刚改过它的那条线程。 */
  otherSessionId: string;
  /** 距今多久（毫秒，不会为负）。 */
  agoMs: number;
}

/** 冲突窗口：超过这个时间不算"并发"，只算历史。 */
export const DEFAULT_CONFLICT_WINDOW_MS = 10 * 60_000;

/**
 * 判断一组待写路径里有哪些被**别的线程**刚改过。
 *
 * 返回按路径字典序排序的事实列表（稳定，方便测试与界面展示）；没有冲突时
 * 返回空数组。`windowMs <= 0` 表示不启用冲突检测（任何写都不算冲突）。
 */
export function conflictFacts(
  paths: readonly string[],
  writes: readonly ThreadWrite[],
  opts: { sessionId: string; now: number; windowMs?: number },
): ConflictFact[] {
  const windowMs = opts.windowMs ?? DEFAULT_CONFLICT_WINDOW_MS;
  if (windowMs <= 0) return [];

  const out: ConflictFact[] = [];
  for (const p of paths) {
    let best: ThreadWrite | undefined;
    for (const w of writes) {
      if (w.path !== p) continue;
      if (w.sessionId === opts.sessionId) continue;
      const agoMs = Math.max(0, opts.now - w.ts);
      if (agoMs > windowMs) continue;
      if (best === undefined || agoMs < Math.max(0, opts.now - best.ts)) best = w;
    }
    if (best !== undefined) out.push({ path: p, otherSessionId: best.sessionId, agoMs: Math.max(0, opts.now - best.ts) });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** 把"多久之前"念成人话：通知与审批弹窗里这句话是唯一的判据线索。 */
export function describeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时前`;
}

/**
 * 冲突事实 → 一句给人看的话。
 *
 * 带上线程 id 的**短尾**（不是完整 uuid）：人不需要认全 id，需要的是"这是
 * 另一条线"的可指认性。
 */
export function describeConflictFacts(facts: readonly ConflictFact[]): string {
  if (facts.length === 0) return "";
  const parts = facts.map((f) => `${f.path}（${shortId(f.otherSessionId)} ${describeAgo(f.agoMs)}改过）`);
  return `这些文件刚被别的线程改过：${parts.join("；")}。要继续写吗？`;
}

/** `chat-1a2b3c4d` → `1a2b3c4d`（取最后 8 位；非 chat- 前缀的原样截尾）。 */
export function shortId(sessionId: string): string {
  const tail = sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
  return `线程 ${tail}`;
}
