import type { Task } from "./types";

export class CycleError extends Error {
  constructor() {
    super("dependency graph contains a cycle");
    this.name = "CycleError";
  }
}

/** Kahn's algorithm; throws CycleError when a topological order does not exist. */
export function topologicalSort(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, t.dependencies.length);
    for (const dep of t.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(t.id);
    }
  }
  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: Task[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== tasks.length) throw new CycleError();
  return order;
}

/**
 * 被「用户跳过的上游」传染到的任务集合（沿依赖边取传递闭包，跳过的任务本身不算）。
 *
 * 为什么需要它：engine 把跳过的依赖**视同已满足**，下游照派 —— 这是刻意的
 * "人自担"语义（下游也许确实不需要那份产物）。但"自担"不等于"任人烧钱"：
 * 这类任务一旦失败，继续吃重修轮、继续弹升级决策，用户每答一次"重派"就多花
 * 一整轮 run 的预算，而它缺的那份产物**永远不会出现**。
 *
 * 这里只回答"谁有这种结构性风险"，处置与措辞留在调用方。
 */
export function skippedDescendants(tasks: Task[], skipped: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of tasks) {
      if (out.has(t.id) || skipped.has(t.id)) continue;
      if (t.dependencies.some((d) => skipped.has(d) || out.has(d))) {
        out.add(t.id);
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * Greedy batching over the topological order: repeatedly start a new batch and
 * fill it with every task whose deps are already done and whose zone is not
 * yet claimed by this batch; zone conflicts defer the task to a later batch.
 */
export function planBatches(tasks: Task[]): Task[][] {
  const sorted = topologicalSort(tasks);
  const batches: Task[][] = [];
  const done = new Set<string>();

  // 循环只由「这一轮有没有进展」驱动。
  //
  // 原条件写成 `done.size < sorted.length && progressed`，但第一个合取项是**冗余的**：
  // 没有进展时循环必然退出，而紧跟其后的 `throw new CycleError()` 正好覆盖
  // "还有任务没排上"的情况。两个条件互为蕴含，多余的合取项对输出没有任何影响。
  // 删掉它而不是留着：它看着承重，实际不做功，还会让变异测试永远杀不掉那个 `&&`
  //（改成 `||` 后只在"全部完成"时多跑一轮空迭代，batches 完全一致）。
  let progressed = true;
  while (progressed) {
    progressed = false;
    const batch: Task[] = [];
    const zonesInBatch = new Set<string>();
    const doneAtBatchStart = new Set(done);
    for (const t of sorted) {
      if (done.has(t.id)) continue;
      const ready = t.dependencies.every((d) => doneAtBatchStart.has(d));
      const zoneFree = !zonesInBatch.has(t.zone);
      if (ready && zoneFree) {
        batch.push(t);
        zonesInBatch.add(t.zone);
        done.add(t.id);
        progressed = true;
      }
    }
    if (batch.length > 0) batches.push(batch);
  }
  if (done.size < sorted.length) throw new CycleError();
  return batches;
}
