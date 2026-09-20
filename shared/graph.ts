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
 * Greedy batching over the topological order: repeatedly start a new batch and
 * fill it with every task whose deps are already done and whose zone is not
 * yet claimed by this batch; zone conflicts defer the task to a later batch.
 */
export function planBatches(tasks: Task[]): Task[][] {
  const sorted = topologicalSort(tasks);
  const batches: Task[][] = [];
  const done = new Set<string>();

  let progressed = true;
  while (done.size < sorted.length && progressed) {
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
