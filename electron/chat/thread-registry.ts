/**
 * 活线程登记表（M4a）。
 *
 * 宿主此前是模块级单例 `let live`：同一时刻只可能有一条线程在跑，`chat:abort`
 * 没有参数也说得通（"中止那条"只有一条）。多线程并行之后这个假设直接塌掉 ——
 * 而且塌得**不报错**：第二线程一建，第一线程的 transcript 就指向最后一个，
 * `chat:abort` 会把别人中止掉。所以这里把"谁活着、谁是最近活跃"抽成一张**可
 * 单独测的表**，IPC 只做寻址。
 *
 * 三条纪律（都是有意的，别"顺手简化"）：
 *
 * 1. **同 id 覆盖 = 替换，不是并存**。宿主重建会话（换签名、恢复、中止后重建）
 *    复用同一个 sessionId；并存会让 `get()` 返回旧对象，而界面按 id 寻址就永远
 *    读不到新会话。
 * 2. **删掉活跃项要把活跃指针清空**，不能让它指向已删除的对象 —— 那会让
 *    `chat:latest` 返回一条已经不存在的线程。
 * 3. **同项目的"最近"按活跃顺序**，不按插入顺序：操作者在 A、B 两条线程间来回
 *    切换后，最该被"恢复"的是最后看的那条。
 *
 * 刻意不做的：并发上限、排队、冲突检测。这些属于调度策略（M4c 与引擎侧），
 * 混进登记表会让"表里有什么"变成"表替我决定了什么"。
 */

/** 登记表只关心寻址需要的字段；业务对象由调用方挂在 `session` 上。 */
export interface LiveThread {
  sessionId: string;
  projectId: string;
  rootAbs: string;
  /** 构造时的运行时签名；设置变了要重建，判定留在宿主。 */
  signature: string;
}

export class ThreadRegistry<T extends LiveThread> {
  /** Map 的插入序就是活跃序：每次 `add`/`touch` 都把该项挪到末尾。 */
  private readonly entries = new Map<string, T>();
  private activeId: string | null = null;

  /**
   * 登记一条线程并置为活跃。
   *
   * 同 id 先删后插 —— `Map.set` 对已存在的键**不改变位置**，直接 set 会让
   * "最近活跃"的判断停在旧位置（旧实现最典型的坑：重建会话后它仍是"最久没动
   * 的那条"）。
   */
  add(entry: T): T {
    this.entries.delete(entry.sessionId);
    this.entries.set(entry.sessionId, entry);
    this.activeId = entry.sessionId;
    return entry;
  }

  get(sessionId: string): T | undefined {
    return this.entries.get(sessionId);
  }

  /** 当前活跃线程；表空或活跃项已被删时返回 undefined。 */
  active(): T | undefined {
    return this.activeId === null ? undefined : this.entries.get(this.activeId);
  }

  /** 切活跃指针；id 不存在时返回 false 且**不改**原指针（不静默丢失活跃项）。 */
  setActive(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    // 先删后插：`Map.set` 对已存在的键不改变位置，直接 set 会让"最近活跃"停在旧位置。
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    this.activeId = sessionId;
    return true;
  }

  /**
   * 该项目里最后一次活跃的线程；`except` 用于"除了我自己还有谁"。
   *
   * 空表/项目无线程时返回 undefined。**不**回退到全局活跃项：跨项目的活跃项
   * 拿来当"本项目的线程"是另一类串台。
   */
  latestOf(projectId: string, except?: string): T | undefined {
    let found: T | undefined;
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId) continue;
      if (except !== undefined && entry.sessionId === except) continue;
      found = entry;
    }
    return found;
  }

  remove(sessionId: string): T | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.entries.delete(sessionId);
    if (this.activeId === sessionId) {
      // 退回到"最后一个还活着的" —— 与 `active()` 的语义保持一致：指针要么指向
      // 一个真存在的项，要么明确为空。
      const rest = [...this.entries.values()];
      this.activeId = rest.length > 0 ? rest[rest.length - 1].sessionId : null;
    }
    return entry;
  }

  all(): T[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.activeId = null;
  }
}
