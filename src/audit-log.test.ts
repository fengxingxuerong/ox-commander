import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, classifyFailure } from "../electron/audit-log";
import { Scheduler } from "../electron/engine/scheduler";
import { AgentRegistry } from "../electron/agents/registry";
import type { AgentAdapter, Task } from "../shared/types";
import type { AgentCapabilities } from "../shared/agent-contract";

const dirs: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

describe("AuditLog", () => {
  it("appends one JSON object per line and reads them back in order", () => {
    const dir = scratch("audit");
    const log = new AuditLog({ dir });
    log.append({ phase: "run-start", taskId: "t1", agentId: "a1", zone: "src" });
    log.append({ phase: "run-end", taskId: "t1", agentId: "a1", ok: false, errorClass: "timeout" });

    const raw = fs.readFileSync(log.currentFile(), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]!).phase).toBe("run-start");

    const records = log.read();
    expect(records.map((r) => r.phase)).toEqual(["run-start", "run-end"]);
    expect(records[1]!.errorClass).toBe("timeout");
    expect(records[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("caps the recorded paths but keeps the real total", () => {
    const dir = scratch("audit-paths");
    const log = new AuditLog({ dir, maxPaths: 3 });
    const rec = log.append({
      phase: "batch-guard",
      paths: ["a", "b", "c", "d", "e"],
      changed: 5,
    });
    expect(rec.paths).toEqual(["a", "b", "c"]);
    expect(rec.pathsTotal).toBe(5);
  });

  it("filters by phase and honours the limit", () => {
    const dir = scratch("audit-filter");
    const log = new AuditLog({ dir });
    log.append({ phase: "agent-change", agentId: "a1", detail: "register" });
    log.append({ phase: "run-end", taskId: "t1", ok: true });
    log.append({ phase: "run-end", taskId: "t2", ok: false });
    expect(log.read({ phase: "run-end" })).toHaveLength(2);
    expect(log.read({ phase: "run-end", limit: 1 })).toHaveLength(1);
    expect(log.read({ phase: "run-end", limit: 1 })[0]!.taskId).toBe("t2");
  });

  it("rotates to a new file once the size budget is exceeded", () => {
    const dir = scratch("audit-rotate");
    const log = new AuditLog({ dir, maxFileBytes: 400 });
    for (let i = 0; i < 20; i++) {
      log.append({ phase: "run-end", taskId: `t${i}`, detail: "x".repeat(60) });
    }
    const files = log.files();
    expect(files.length).toBeGreaterThan(1);
    // Every record survives rotation, and ordering is by filename.
    expect(log.read()).toHaveLength(20);
  });

  it("appends to the newest file when reopened", () => {
    const dir = scratch("audit-reopen");
    new AuditLog({ dir }).append({ phase: "run-start", taskId: "t1" });
    const second = new AuditLog({ dir });
    second.append({ phase: "run-end", taskId: "t1", ok: true });
    expect(second.read()).toHaveLength(2);
    expect(second.files()).toHaveLength(1);
  });

  it("creates a nested directory tree on first use", () => {
    const dir = path.join(scratch("audit-mkdir"), "a", "b");
    const log = new AuditLog({ dir });
    log.append({ phase: "settings", detail: "x" });
    expect(log.read()).toHaveLength(1);
    expect(fs.existsSync(log.currentFile())).toBe(true);
  });

  it("exportTo 把全部历史原样拼进一个文件（oldest first，逐行不改写）", () => {
    const dir = scratch("audit-export");
    // 第一条正常写；再灌满一个小额度触发滚动，制造"跨两个文件的历史"
    const log = new AuditLog({ dir, maxFileBytes: 400 });
    log.append({ phase: "run-start", runId: "run-1" });
    for (let i = 0; i < 5; i += 1) {
      log.append({ phase: "batch-guard", agentId: "a", ok: false, errorClass: "conflict", detail: `pad-${i}` });
    }
    expect(log.files().length).toBeGreaterThanOrEqual(2);

    const target = path.join(scratch("audit-export-target"), "out.jsonl");
    const returned = log.exportTo(target);
    expect(returned).toBe(target);

    const lines = fs.readFileSync(target, "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(6);
    // 每行仍是合法 JSON，且顺序就是落盘顺序（oldest first）：第一行是 run-start
    const first = JSON.parse(lines[0]!) as { phase: string };
    expect(first.phase).toBe("run-start");
  });

  it("exportTo 目标目录不存在时创建它，写盘失败时如实上抛", () => {
    const dir = scratch("audit-export-mkdir");
    const log = new AuditLog({ dir });
    log.append({ phase: "run-start", runId: "run-1" });

    const target = path.join(scratch("audit-export-target2"), "deep", "out.jsonl");
    expect(log.exportTo(target)).toBe(target);
    expect(fs.existsSync(target)).toBe(true);

    // 指向一个目录路径 → writeFileSync 必然失败，错误要浮出来而不是被吞掉：
    // 导出是拿去做证据的，静默产出空文件比失败更糟。
    const badTarget = path.join(scratch("audit-export-bad"), "occupied");
    fs.mkdirSync(badTarget);
    expect(() => log.exportTo(badTarget)).toThrow();
  });
});

describe("classifyFailure", () => {
  it("maps the common failure shapes to coarse classes", () => {
    expect(classifyFailure("LLM HTTP 401: invalid api key")).toBe("auth");
    expect(classifyFailure("LLM HTTP 429: too many requests")).toBe("rate-limit");
    expect(classifyFailure("全部 LLM 路由冷却中")).toBe("rate-limit");
    expect(classifyFailure("看门狗触发（空闲无输出）")).toBe("timeout");
    expect(classifyFailure("files-protocol 校验失败")).toBe("protocol");
    expect(classifyFailure("zone 越权：本批任务修改了声明 zone 之外的文件")).toBe("conflict");
    expect(classifyFailure("no agent available")).toBe("no-agent");
    expect(classifyFailure("ENOSPC: no space left")).toBe("resource");
    expect(classifyFailure("something else entirely")).toBe("unknown");
  });
});

describe("Scheduler concurrency cap", () => {
  function task(id: string, zone: string): Task {
    return { id, title: id, description: "", zone, dependencies: [], suggestedRole: "backend-dev" };
  }

  /** Adapter that stays "running" until released, so concurrency is observable. */
  function gateAdapter(id: string, state: { peak: number; inflight: number; releases: Array<() => void> }): AgentAdapter {
    const caps: AgentCapabilities = {
      roles: ["backend-dev"],
      zoneGlobs: ["**"],
      supports: ["read", "edit"],
      artifactKinds: ["files"],
      maxConcurrency: 10,
      selfIsolated: true,
    };
    const base: AgentAdapter = {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        state.inflight += 1;
        state.peak = Math.max(state.peak, state.inflight);
        await new Promise<void>((resolve) => state.releases.push(resolve));
        state.inflight -= 1;
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed" as const, text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
    return Object.assign(base, { capabilities: () => caps });
  }

  it("never exceeds maxParallelRuns, and the run completes", async () => {
    const state = { peak: 0, inflight: 0, releases: [] as Array<() => void> };
    const adapter = gateAdapter("a1", state);
    const registry = new AgentRegistry([{ adapter }]);
    const sched = new Scheduler([adapter], [], {
      registry,
      maxParallelRuns: 2,
    });

    const pending = sched.runBatch(
      [task("t1", "z1"), task("t2", "z2"), task("t3", "z3"), task("t4", "z4")],
      ".",
    );
    /*
     * 先等"两个槽确实被占住"再判上限：只睡固定时长然后断 `peak <= 2`，
     * 在调度器根本还没起跑时也是空的（vacuous pass）—— 上限必须由
     * "已经满了 + 后面还有任务在排队"这两件事一起证明。
     */
    await vi.waitFor(() => expect(state.peak).toBe(2));
    expect(sched.activeRuns()).toBe(2);
    expect(state.peak).toBeLessThanOrEqual(2);

    // Release everything; waiters are admitted as slots free up.
    const settled = pending.then((o) => o);
    for (let i = 0; i < 20 && state.releases.length + state.inflight > 0; i++) {
      while (state.releases.length > 0) state.releases.shift()!();
      await new Promise((r) => setTimeout(r, 10));
    }
    const outcomes = await settled;
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true, true]);
    expect(state.peak).toBe(2);
    expect(sched.activeRuns()).toBe(0);
  });

  it("treats 0 as unlimited", async () => {
    const state = { peak: 0, inflight: 0, releases: [] as Array<() => void> };
    const adapter = gateAdapter("a1", state);
    const registry = new AgentRegistry([{ adapter }]);
    const sched = new Scheduler([adapter], [], { registry, maxParallelRuns: 0 });
    const pending = sched.runBatch([task("t1", "z1"), task("t2", "z2"), task("t3", "z3")], ".");
    /*
     * 等"三个都进来了"这个**条件**，而不是睡固定 30ms 再判 `peak === 3`：
     * 后者把断言压在墙钟上，共享 runner 卡一下就红在一次抖动上，跟并发上限无关。
     */
    await vi.waitFor(() => expect(state.peak).toBe(3));
    for (let i = 0; i < 3; i++) state.releases.shift()?.();
    await expect(pending).resolves.toHaveLength(3);
  });
});

describe("Scheduler run attribution", () => {
  function task(id: string, zone: string): Task {
    return { id, title: id, description: "", zone, dependencies: [], suggestedRole: "backend-dev" };
  }

  function adapter(id: string, ok: boolean, logDigest = "boom"): AgentAdapter {
    const base: AgentAdapter = {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "log" as const, text: logDigest, timestamp: Date.now() };
        yield ok
          ? { kind: "completed" as const, text: "done", timestamp: Date.now() }
          : { kind: "failed" as const, text: "exit 1", timestamp: Date.now() };
      },
      async abort() {},
    };
    return base;
  }

  it("stamps outcomes with agentId, duration and failure class", async () => {
    const events: string[] = [];
    const sched = new Scheduler(
      [adapter("worker-1", false, "zone 越权：本批任务修改了声明 zone 之外的文件")],
      [],
      {
        onRunStart: (agentId, t) => events.push(`start:${agentId}:${t.id}`),
        onRunComplete: (o, t) => events.push(`end:${t.id}:${o.ok}:${o.agentId}:${o.errorClass}`),
      },
    );
    const outcomes = await sched.runBatch([task("t1", "src")], ".");
    expect(outcomes[0]!.agentId).toBe("worker-1");
    expect(outcomes[0]!.errorClass).toBe("conflict");
    expect(outcomes[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]).toBe("start:worker-1:t1");
    expect(events[1]).toBe("end:t1:false:worker-1:conflict");
  });

  it("still reports a terminal outcome when no agent is available", async () => {
    const events: string[] = [];
    const sched = new Scheduler([], [], {
      onRunComplete: (o) => events.push(`${o.taskId}:${o.ok}:${o.errorClass}`),
    });
    await sched.runBatch([task("t1", "src")], ".");
    expect(events).toEqual(["t1:false:no-agent"]);
  });

  it("feeds an audit log with a complete run-start / run-end pair", async () => {
    const dir = scratch("audit-integration");
    const audit = new AuditLog({ dir });
    const sched = new Scheduler([adapter("worker-1", true)], [], {
      onRunStart: (agentId, t) => audit.append({ phase: "run-start", agentId, taskId: t.id, zone: t.zone }),
      onRunComplete: (o, t) =>
        audit.append({
          phase: "run-end",
          taskId: t.id,
          ok: o.ok,
          ...(o.agentId ? { agentId: o.agentId } : {}),
          ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
        }),
    });
    await sched.runBatch([task("t1", "src")], ".");

    const records = audit.read();
    expect(records.map((r) => r.phase)).toEqual(["run-start", "run-end"]);
    expect(records[0]!.agentId).toBe("worker-1");
    expect(records[1]!.ok).toBe(true);
    // The four-tuple an operator needs to reconstruct a run.
    expect(records[1]).toHaveProperty("taskId");
    expect(records[1]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("AuditLog · retention", () => {
  /** Forces a roll on every append by capping the file at one byte. */
  function tiny(tag: string, maxFiles: number): AuditLog {
    return new AuditLog({ dir: scratch(tag), maxFileBytes: 1, maxFiles });
  }

  it("keeps at most maxFiles rolled files", () => {
    const audit = tiny("audit-retain", 3);
    for (let i = 0; i < 12; i++) audit.append({ phase: "settings", detail: `r${i}` });
    // Rolling without a cap was an unbounded disk leak in long-lived projects.
    expect(audit.files().length).toBeLessThanOrEqual(3);
  });

  it("never deletes the file it is currently appending to", () => {
    const audit = tiny("audit-current", 2);
    for (let i = 0; i < 8; i++) audit.append({ phase: "settings", detail: `r${i}` });
    expect(fs.existsSync(audit.currentFile())).toBe(true);
    // With maxFiles: 1 the sweep must still not consider the active file doomed.
    const solo = tiny("audit-solo", 1);
    for (let i = 0; i < 5; i++) solo.append({ phase: "settings", detail: `r${i}` });
    expect(fs.existsSync(solo.currentFile())).toBe(true);
  });

  it("sweeps pre-existing surplus on construction", () => {
    const dir = scratch("audit-sweep");
    // Simulate a directory left behind by a version with no retention at all.
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `audit-2026-01-01-${String(i).padStart(3, "0")}.jsonl`), "{}\n", "utf8");
    }
    const audit = new AuditLog({ dir, maxFiles: 4 });
    expect(audit.files().length).toBeLessThanOrEqual(4);
  });

  it("keeps the newest records readable after a sweep", () => {
    const audit = tiny("audit-recent", 3);
    for (let i = 0; i < 9; i++) audit.append({ phase: "settings", detail: `r${i}` });
    // Retention trims history, not the tail an operator actually needs.
    expect(audit.read({ limit: 1 })[0]!.detail).toBe("r8");
  });
});

describe('AuditLog · 容错与文件识别', () => {
  it('只认 audit-*.jsonl —— 名字只满足一半的文件不进历史', () => {
    const dir = scratch('audit-shape');
    const audit = new AuditLog({ dir });
    audit.append({ phase: 'settings', detail: 'real' });
    // 两个「只满足一半」的名字：`&&` 放宽成 `||` 会把它们并进历史 ——
    // 导出时会一起被带走，历史里就混进了不是审计日志的东西。
    fs.writeFileSync(path.join(dir, 'audit-2026-01-01-999.txt'), '{"ts":"t","phase":"settings","detail":"半对-txt"}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.jsonl'), '{"ts":"t","phase":"settings","detail":"半对-jsonl"}\n', 'utf8');
    expect(audit.files().map((f) => path.basename(f))).toEqual([path.basename(audit.currentFile())]);
    expect(audit.read().map((r) => r.detail)).toEqual(['real']);
  });

  it('历史里夹着空行时，后面的记录照旧读回', () => {
    const dir = scratch('audit-blank');
    const audit = new AuditLog({ dir });
    audit.append({ phase: 'run-start', detail: 'first' });
    // 进程被杀时的半行 / 空行是常态：`continue` 改成 `break` 会让整段历史
    // 从空行处截断，表现为「日志莫名其妙只剩一半」且无从报错。
    fs.appendFileSync(
      audit.currentFile(),
      '\n' + JSON.stringify({ ts: 't', phase: 'run-end', detail: 'second' }) + '\n',
      'utf8',
    );
    expect(audit.read().map((r) => r.detail)).toEqual(['first', 'second']);
  });

  it('重开时接着最新那个文件写，而不是从 000 另起一个', () => {
    const dir = scratch('audit-reopen');
    // 名字刻意带 003 且与今天不同日：`pickFile` 的 `length === 0` 反向时，
    // 非空目录会一律走 newFile(0) —— 只有索引不为 0 的输入才看得出差别。
    fs.writeFileSync(
      path.join(dir, 'audit-2020-01-01-003.jsonl'),
      JSON.stringify({ ts: 't', phase: 'settings', detail: 'old' }) + '\n',
      'utf8',
    );
    const audit = new AuditLog({ dir });
    audit.append({ phase: 'settings', detail: 'new' });
    expect(path.basename(audit.currentFile())).toBe('audit-2020-01-01-003.jsonl');
    expect(audit.read().map((r) => r.detail)).toEqual(['old', 'new']);
  });

  /**
   * 造一个「读不出来」的条目：用**同名目录**冒充文件（readFileSync 一个目录
   * 会抛 EISDIR）。比 mock 掉 fs 更真实 —— 它是磁盘上真会出现的东西。
   */
  function withUnreadableEntry(tag: string): AuditLog {
    const dir = scratch(tag);
    fs.mkdirSync(path.join(dir, 'audit-2020-01-01-000.jsonl'));
    fs.writeFileSync(
      path.join(dir, 'audit-2020-01-02-000.jsonl'),
      JSON.stringify({ ts: 't', phase: 'run-end', detail: 'good' }) + '\n',
      'utf8',
    );
    return new AuditLog({ dir });
  }

  it('某个文件读不出来时跳过它，后面的历史照旧读回', () => {
    const audit = withUnreadableEntry('audit-unreadable');
    expect(audit.read().map((r) => r.detail)).toEqual(['good']);
  });

  it('exportTo 跳过读不出来的文件，其余历史照旧导出', () => {
    const audit = withUnreadableEntry('audit-export-partial');
    const target = path.join(scratch('audit-export-out'), 'history.jsonl');
    audit.exportTo(target);
    const text = fs.readFileSync(target, 'utf8');
    expect(text).toContain('good');
    expect(text.trim().split('\n')).toHaveLength(1);
  });
});
