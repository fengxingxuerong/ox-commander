/**
 * 活跃线程的写记录（M4c · P1）。
 *
 * 冲突检测要回答"这个文件刚被**哪条活跃线程**改过"，而这个信息只在内存里
 * 存在一小会儿 —— 落盘的会话记录里没有"谁此刻在跑"这回事。所以主进程按
 * 线程记一份极短的台账：谁、改了哪个文件、什么时候。
 *
 * 三条纪律：
 * 1. **只存活跃线程**：线程被删除/中止并移出登记表时一并清掉它的记录；
 *    否则一个已经不存在的线程会继续"拦"后来的写。
 * 2. **有上限**：冲突检测只看窗口内的写，更早的记录既用不上也占内存。
 *    超出上限丢**最旧的**（`splice(0, n)`），不是最新的 —— 反过来会丢掉
 *    恰恰最该拦的那几条。
 * 3. **不持久化**：重启后台账为空是正确行为 —— 重启后没有"刚才"，
 *    把一个陈旧记录当成并发线索只会误伤。
 */
import type { ThreadWrite } from "../../shared/chat-conflict";

/** 台账上限（全进程）；超了丢最旧的。 */
const MAX_RECORDS = 500;

const records: ThreadWrite[] = [];

export function recordThreadWrites(sessionId: string, paths: readonly string[], now = Date.now()): void {
  for (const p of paths) {
    if (p === "") continue;
    records.push({ sessionId, path: p, ts: now });
  }
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function threadWrites(): readonly ThreadWrite[] {
  return records;
}

/** 线程结束/被删：它的记录一起走，别让已不存在的线程继续拦人。 */
export function clearThreadWrites(sessionId: string): void {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]!.sessionId === sessionId) records.splice(i, 1);
  }
}

/** 重装配 IPC / 应用退出：整本台账清空（内存态不跨会话）。 */
export function resetThreadWrites(): void {
  records.length = 0;
}
