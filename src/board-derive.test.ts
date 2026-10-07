import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../electron/audit-log";
import { deriveBoardView, taskTrail, trailBriefForRepair } from "../electron/board-derive";
import type { DeliveryReceipt } from "../shared/delivery-receipt";

/**
 * Behavioural lock for the board-recovery derive layer (facts/derived split).
 *
 * The audit trail is the durable fact store; these tests pin how the view is
 * reduced from it — including the interrupted semantics that motivated the
 * feature (a killed process tree leaves a run-start with no matching run-end,
 * and the board must say so instead of showing a blank board).
 */

const start = (over: Partial<AuditRecord>): AuditRecord => ({
  ts: "2026-09-29T10:00:00.000Z",
  phase: "run-start",
  taskId: "t1",
  ...over,
});

const end = (over: Partial<AuditRecord>): AuditRecord => ({
  ts: "2026-09-29T10:01:00.000Z",
  phase: "run-end",
  taskId: "t1",
  ok: true,
  ...over,
});

const receipt = (over: Partial<DeliveryReceipt>): DeliveryReceipt =>
  ({
    runId: "r1",
    outcome: "delivered",
    headline: "3/3 完成",
    counts: { total: 3, done: 3, failed: 0, skipped: 0, pending: 0 },
    checks: [],
    conflicts: [],
    tasks: [],
    rounds: 0,
    ...over,
  }) as unknown as DeliveryReceipt;

describe("deriveBoardView", () => {
  it("returns an empty view for an empty trail", () => {
    expect(deriveBoardView([])).toEqual({ tasks: {}, interrupted: false });
  });

  it("derives a done task with full attribution from a start/end pair", () => {
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", title: "登录页", zone: "src/auth", agentId: "planned" }),
      end({ taskId: "t1", ok: true, agentId: "actual", durationMs: 4200 }),
    ]);
    expect(view.tasks.t1).toEqual({
      taskId: "t1",
      title: "登录页",
      zone: "src/auth",
      status: "done",
      attempts: 1,
      agentId: "actual",
      durationMs: 4200,
    });
    // Actual attribution wins over the planned one recorded at run-start.
    expect(view.tasks.t1?.agentId).toBe("actual");
    expect(view.interrupted).toBe(false);
    expect(view.lastActivityTs).toBe("2026-09-29T10:01:00.000Z");
  });

  it("derives a failed task with error class and digest", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", title: "登录页", zone: "src/auth" }),
      end({ taskId: "t1", ok: false, errorClass: "rate-limit", detail: "429 rate limited" }),
    ]);
    expect(view.tasks.t1).toMatchObject({
      status: "failed",
      errorClass: "rate-limit",
      failureDigest: "429 rate limited",
      attempts: 1,
    });
  });

  it("keeps attempts across repair rounds and clears stale failure marks on success", () => {
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", title: "登录页", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: false, errorClass: "timeout", detail: "boom" }),
      start({ ts: "2026-09-29T10:02:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:03:00.000Z", taskId: "t1", ok: true, agentId: "a2", durationMs: 100 }),
    ]);
    const task = view.tasks.t1!;
    expect(task.status).toBe("done");
    expect(task.attempts).toBe(2);
    expect("errorClass" in task).toBe(false);
    expect("failureDigest" in task).toBe(false);
    expect(task.agentId).toBe("a2");
    // Title survives from the first start even if the retry start omits it.
    expect(task.title).toBe("登录页");
  });

  it("marks the trail interrupted when a run-start has no matching run-end", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", title: "A", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      start({ ts: "2026-09-29T10:02:00.000Z", taskId: "t2", title: "B", zone: "z" }),
    ]);
    expect(view.interrupted).toBe(true);
    // The killed run is shown as still-running: that is the last fact known.
    expect(view.tasks.t2).toMatchObject({ status: "running", attempts: 1 });
    expect(view.tasks.t1).toMatchObject({ status: "done" });
  });

  it("un-marks interrupted once a later run-end closes the start", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", zone: "z" }),
      end({ taskId: "t1", ok: false, errorClass: "timeout" }),
    ]);
    expect(view.interrupted).toBe(false);
  });

  it("derives stage and receipt from their facts, last one wins", () => {
    const r = receipt({ outcome: "blocked", headline: "1/3 完成" });
    const view = deriveBoardView([
      { ts: "2026-09-29T10:00:00.000Z", phase: "stage", stage: "DEVELOPMENT" },
      { ts: "2026-09-29T10:01:00.000Z", phase: "stage", stage: "VERIFICATION" },
      { ts: "2026-09-29T10:02:00.000Z", phase: "receipt", receipt: r },
      // A run fact after the receipt: the stage/receipt branches must hand
      // control back (continue), not stop the trail (break) — a receipt that
      // ends the reduction would silently drop everything after it.
      start({ ts: "2026-09-29T10:03:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:04:00.000Z", taskId: "t1", ok: true }),
    ]);
    expect(view.stage).toBe("VERIFICATION");
    expect(view.receipt?.headline).toBe("1/3 完成");
    expect(view.tasks.t1).toMatchObject({ status: "done" });
    expect(view.lastActivityTs).toBe("2026-09-29T10:04:00.000Z");
  });

  it("ignores noise phases and records without a taskId", () => {
    const view = deriveBoardView([
      { ts: "2026-09-29T10:00:00.000Z", phase: "settings", detail: " saved" },
      { ts: "2026-09-29T10:00:01.000Z", phase: "batch-guard", changed: 3, paths: ["a"] },
      { ts: "2026-09-29T10:00:02.000Z", phase: "agent-change", agentId: "x", detail: "enabled" },
    ]);
    expect(view.tasks).toEqual({});
    expect(view.stage).toBeUndefined();
    expect(view.interrupted).toBe(false);
    // Nothing recovery-relevant happened, so no activity stamp either.
    expect(view.lastActivityTs).toBeUndefined();
  });

  it("malformed stage/receipt facts change neither the view nor the activity stamp", () => {
    // The writers always attach the payload, but a truncated or future-happy
    // record must degrade to "not a fact" — not to "a fact of nothing" that
    // still moves lastActivityTs forward.
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      { ts: "2026-09-29T10:02:00.000Z", phase: "stage" },
      { ts: "2026-09-29T10:03:00.000Z", phase: "receipt" },
    ]) as unknown as Record<string, unknown>;
    expect("stage" in view).toBe(false);
    expect("receipt" in view).toBe(false);
    // The malformed tail must not pretend the trail was active up to 10:03.
    expect(view.lastActivityTs).toBe("2026-09-29T10:01:00.000Z");
  });

  it("a noise phase carrying a taskId stays noise, and later facts still count", () => {
    // settings records can carry a taskId (the writer attaches context); the
    // noise filter must ignore them regardless, and must keep consuming the
    // trail afterwards — both a swapped filter and an early stop would here
    // either corrupt t1 or silently drop t2.
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      { ts: "2026-09-29T10:02:00.000Z", phase: "settings", taskId: "t1", detail: " saved" },
      start({ ts: "2026-09-29T10:03:00.000Z", taskId: "t2", zone: "z" }),
      end({ ts: "2026-09-29T10:04:00.000Z", taskId: "t2", ok: true }),
    ]);
    expect(view.tasks.t1).toMatchObject({ status: "done" });
    expect(view.tasks.t2).toMatchObject({ status: "done" });
    expect(view.lastActivityTs).toBe("2026-09-29T10:04:00.000Z");
  });

  it("derives a task from a run-end alone when the start was rotated away", () => {
    const view = deriveBoardView([end({ taskId: "t9", ok: true })]);
    expect(view.tasks.t9).toEqual({
      taskId: "t9",
      title: "t9",
      zone: "",
      status: "done",
      attempts: 1,
    });
  });

  it("omits optional keys entirely when the facts lack them", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", zone: "z", title: "T" }),
      end({ taskId: "t1", ok: true }),
    ]);
    const task = view.tasks.t1 as unknown as Record<string, unknown>;
    // Same contract as the audit writer: absent fact → absent key.
    expect("agentId" in task).toBe(false);
    expect("durationMs" in task).toBe(false);
    expect("failureDigest" in task).toBe(false);
    expect("errorClass" in task).toBe(false);
    // And the view-level optionals stay absent when no such facts exist —
    // but a run-start IS an activity fact, so lastActivityTs must be present.
    const bare = deriveBoardView([start({ taskId: "t1", zone: "z" })]) as unknown as Record<string, unknown>;
    expect("stage" in bare).toBe(false);
    expect("receipt" in bare).toBe(false);
    expect(bare.lastActivityTs).toBe("2026-09-29T10:00:00.000Z");
    const noise = deriveBoardView([
      { ts: "2026-09-29T11:00:00.000Z", phase: "settings", detail: "x" },
    ]) as unknown as Record<string, unknown>;
    expect("lastActivityTs" in noise).toBe(false);
  });
});

describe("taskTrail · 一个任务的运行履历（P1-3 上下文回溯）", () => {
  // deriveBoardView 只说"现在是什么状态"；这条说"它经历过什么" —— 重修轮里同一个
  // 任务会换执行器，前一次为什么失败、换谁重派的，正是要回溯的东西。
  it("按时间顺序列出每一次派发，执行器取 run-end 的真实值", () => {
    const trail = taskTrail(
      [
        start({ ts: "t-0", agentId: "planned-a", title: "登录页", zone: "src/auth" }),
        end({ ts: "t-1", agentId: "actual-b", ok: false, errorClass: "timeout", detail: "boom", durationMs: 12 }),
        start({ ts: "t-2", agentId: "planned-b" }),
        end({ ts: "t-3", agentId: "actual-c", ok: true, durationMs: 34 }),
      ],
      "t1",
    );
    expect(trail.runs).toHaveLength(2);
    expect(trail.runs[0]).toEqual({
      startedAt: "t-0",
      endedAt: "t-1",
      agentId: "actual-b",
      ok: false,
      durationMs: 12,
      errorClass: "timeout",
      digest: "boom",
    });
    // 第二次成功：不该把上一条的错误带过来（失败与成功是两次派发）
    expect(trail.runs[1]).toEqual({ startedAt: "t-2", endedAt: "t-3", agentId: "actual-c", ok: true, durationMs: 34 });
    expect(trail.title).toBe("登录页");
    expect(trail.zone).toBe("src/auth");
  });

  it("只挑这个任务的事实，别家的不算", () => {
    const trail = taskTrail([start({ taskId: "t2" }), end({ taskId: "t2" }), start({ ts: "x" })], "t1");
    expect(trail.runs).toHaveLength(1);
    expect(trail.runs[0]!.startedAt).toBe("x");
  });

  it("被腰斩的那次没有收尾：endedAt 缺席（不是填个假时间）", () => {
    const trail = taskTrail([start({ ts: "s1", agentId: "a1" })], "t1");
    expect(trail.runs).toEqual([{ startedAt: "s1", agentId: "a1" }]);
    expect("endedAt" in trail.runs[0]!).toBe(false);
  });

  it("前一次没闭合又重派 ⇒ 两条都在（事实不能丢）", () => {
    const trail = taskTrail([start({ ts: "s1" }), start({ ts: "s2" }), end({ ts: "e2", ok: true })], "t1");
    expect(trail.runs).toHaveLength(2);
    expect("endedAt" in trail.runs[0]!).toBe(false); // 第一次被腰斩
    expect(trail.runs[1]).toEqual({ startedAt: "s2", endedAt: "e2", ok: true });
  });

  it("run-end 早于任何 start（start 被轮转掉）⇒ 照样算一次派发", () => {
    const trail = taskTrail([end({ ts: "e0", ok: false, errorClass: "auth", detail: "401" })], "t1");
    expect(trail.runs).toEqual([
      { endedAt: "e0", ok: false, errorClass: "auth", digest: "401" },
    ]);
    expect("startedAt" in trail.runs[0]!).toBe(false);
  });

  it("没配对的其它 phase（stage / receipt / batch-guard）不进履历", () => {
    const trail = taskTrail(
      [
        { ts: "x", phase: "stage", stage: "VERIFICATION", taskId: "t1" },
        { ts: "x", phase: "batch-guard", taskId: "t1", changed: 2 },
        start({}),
        end({ ok: true }),
      ],
      "t1",
    );
    expect(trail.runs).toHaveLength(1);
  });
});

describe("trailBriefForRepair · 履历压成给下一个执行器读的文本（P1-3 闭环）", () => {
  // 闭环的那一半：履历此前只流到 UI（人看），agent 读不到。重修上下文里只有
  // "现在哪里错了"，没有"这条路已经走过" —— 于是每次重试都从零开始。
  const brief = (records: Parameters<typeof taskTrail>[0], taskId = "t1") =>
    trailBriefForRepair(taskTrail(records, taskId));

  it("成功过的履历不产生任何提示（成功的过去没有接力价值）", () => {
    expect(brief([start({ ts: "s" }), end({ ts: "e", ok: true })])).toBe("");
  });

  it("同类失败聚合计数，不逐次罗列（prompt 体积与失败次数解耦）", () => {
    const text = brief([
      start({ ts: "s1" }),
      end({ ts: "e1", ok: false, errorClass: "timeout", detail: "x" }),
      start({ ts: "s2" }),
      end({ ts: "e2", ok: false, errorClass: "timeout", detail: "y" }),
      start({ ts: "s3" }),
      end({ ts: "e3", ok: false, errorClass: "timeout", detail: "z" }),
    ]);
    expect(text).toContain("已失败 3 次");
    expect(text).toContain("timeout × 3");
    // 三次失败只出现一次计数，不是三行 —— 摘要不随失败次数膨胀
    expect(text.match(/timeout/g)).toHaveLength(1);
  });

  it("不同错误类分开报，agent 能看出换了路没有", () => {
    const text = brief([
      start({ ts: "s1" }),
      end({ ts: "e1", ok: false, errorClass: "timeout" }),
      start({ ts: "s2" }),
      end({ ts: "e2", ok: false, errorClass: "protocol" }),
    ]);
    expect(text).toContain("timeout × 1");
    expect(text).toContain("protocol × 1");
  });

  /**
   * 履历这一路也必须收窄（2026-10-07）—— 同一缺陷族的**第三处**。
   *
   * 前两处（`store.ts` 的 IPC 事件路径、`deriveBoardView` 的恢复路径）修完之后，
   * `TrailRun.errorClass` 仍是 `string`：它把 `AuditRecord.errorClass`
   * 原样搬进履历，而 `trailBriefForRepair` 会把 `${cls} × ${n}`
   * **直接印进给下一个执行器读的那段 prompt**。
   *
   * 后果与界面上的裸 token 同族、但更难发现：界面上的「contract」至少还有个人
   * 会看见并报过来，prompt 里的 `quantum-flux × 2` 只有模型看得见 ——
   * 而它拿一个没人登记过的词做不出任何判断（"换思路"这件事需要它知道**换过什么**）。
   *
   * 断言两处：履历里的值本身要是 `unknown`，压出来的文本里**不能**出现那个裸 token。
   */
  it("履历里的未登记 errorClass 归 unknown（它要被印进 prompt，不是给人看的）", () => {
    const trail = taskTrail([end({ ts: "e1", ok: false, errorClass: "quantum-flux", detail: "x" })], "t1");
    expect(trail.runs[0]!.errorClass).toBe("unknown");
  });

  it("压给下一个执行器的文本里不出现登记外的类别", () => {
    const text = brief([start({ ts: "s1" }), end({ ts: "e1", ok: false, errorClass: "quantum-flux" })]);
    expect(text).toContain("unknown × 1");
    expect(text).not.toContain("quantum-flux");
  });

  it("履历里的九档在册值原样保留（收窄不是一律吞掉）", () => {
    for (const c of [
      "auth", "rate-limit", "timeout", "protocol",
      "conflict", "resource", "no-agent", "contract", "unknown",
    ] as const) {
      const trail = taskTrail([end({ ts: "e1", ok: false, errorClass: c })], "t1");
      expect(trail.runs[0]!.errorClass, `class=${c}`).toBe(c);
    }
  });

  it("点名上一任执行器（是谁跑失败的比第一个是谁有用）", () => {
    const text = brief([
      start({ ts: "s1", agentId: "planned-a" }),
      end({ ts: "e1", agentId: "actual-a", ok: false, errorClass: "auth" }),
      start({ ts: "s2", agentId: "planned-b" }),
      end({ ts: "e2", agentId: "actual-b", ok: false, errorClass: "auth" }),
    ]);
    expect(text).toContain("上一任执行器：actual-b");
    expect(text).not.toContain("planned-b"); // 计划值不是"谁真的跑过"
  });

  it("腰斩的派发单列，不混进失败计数（原因未知 ≠ 失败）", () => {
    const text = brief([
      start({ ts: "s1" }),
      start({ ts: "s2" }), // 第一次被腰斩，没有 end
      end({ ts: "e2", ok: false, errorClass: "timeout" }),
    ]);
    expect(text).toContain("另有 1 次派发没有收尾");
    expect(text).toContain("原因未知");
    expect(text).toContain("已失败 1 次"); // 只有真正跑完的那次算失败
  });

  it("没有腰斩时就不提那件事（不许出现「另有 0 次」）", () => {
    // 计数守卫：unfinished=0 时输出「另有 0 次派发没有收尾」是噪声，且会把
    // "没有这回事"说成"有 0 次这回事"。反向注入把 > 0 改成 >= 0 靠这条抓。
    const text = brief([
      start({ ts: "s1", agentId: "a1" }),
      end({ ts: "e1", agentId: "a1", ok: false, errorClass: "timeout" }),
    ]);
    expect(text).toContain("已失败 1 次");
    expect(text).not.toContain("没有收尾");
  });

  it("只有腰斩、没有一次失败收尾 ⇒ 说清「没失败过」而不是谎报已失败0 次", () => {
    // 边界：failed 非空（有一条腰斩）但 byClass 空。上一任也不提（腰斩的执行器
    // 归属是计划值，不是"谁真的跑过"）。计数必须是 0，且腰斩那行必须在。
    const text = brief([start({ ts: "s1", agentId: "planned-a" })]);
    expect(text).toContain("已失败 0 次");
    expect(text).toContain("另有 1 次派发没有收尾");
    expect(text).not.toContain("上一任执行器");
  });

  it("缺 errorClass 的失败归unknown（字段即承诺：不猜原因）", () => {
    const text = brief([start({ ts: "s" }), end({ ts: "e", ok: false })]);
    expect(text).toContain("unknown × 1");
  });

  /**
   * 恢复路径上的 `errorClass` 也必须收窄（2026-10-07）。
   *
   * 与 `src/store.ts` 的事件路径是**同一个缺陷的两个入口**：
   * `AuditRecord.errorClass` 是 `string`（JSONL 来自
   * `JSON.parse(line) as AuditRecord` —— 旧版本写的、人手改过的都算数），
   * 而 `DerivedTask.errorClass` 是 `FailureClass`。
   *
   * 旧写法 `record.errorClass ?? "unknown"` 直接接上，未登记的值会一路进到
   * 看板的 `Record<FailureClass, string>`，落到 `ERROR_LABELS[c] ?? c` 兜底，
   * 中文界面吐出裸 token。
   *
   * ⚠️ 说法要准：这两条错误**不是 HEAD 上就有的红**。本轮开工前 `npm run verify`
   * 在 `18ee758` 上 EXIT 0 —— 它们是本次把 `DerivedTask.errorClass` 收紧成
   * `FailureClass` 之后**当场**冒出来的，属于改造过程的中间态。
   * 写清楚这一点是为了不给将来留错觉：不是"typecheck 段本来就红"，
   * 而是"**收紧类型这一手会立刻指出哪些边界还没收窄**" —— 那正是它的价值。
   */
  it("未登记的 errorClass 归 unknown，不原样透传", () => {
    const view = deriveBoardView([end({ ts: "e", taskId: "t1", ok: false, errorClass: "quantum-flux" })]);
    expect(view.tasks["t1"]!.errorClass).toBe("unknown");
  });

  it("非字符串的 errorClass 也归 unknown", () => {
    const view = deriveBoardView([end({ ts: "e", taskId: "t1", ok: false, errorClass: 42 as never })]);
    expect(view.tasks["t1"]!.errorClass).toBe("unknown");
  });

  it("在册的九档原样保留（收窄不是一律吞掉）", () => {
    for (const c of [
      "auth", "rate-limit", "timeout", "protocol",
      "conflict", "resource", "no-agent", "contract", "unknown",
    ] as const) {
      const view = deriveBoardView([end({ ts: "e", taskId: "t1", ok: false, errorClass: c })]);
      expect(view.tasks["t1"]!.errorClass, `class=${c}`).toBe(c);
    }
  });

  it("无执行器归属时不提「上一任」（字段即承诺：没有就不编）", () => {
    const text = brief([end({ ts: "e", ok: false, errorClass: "auth" })]);
    expect(text).toContain("已失败 1 次");
    expect(text).not.toContain("上一任执行器");
  });

  it("带上一任时给出「别再走同一条路」的明确指令", () => {
    // 断言要点：这段文本的唯一目的是改变下一个 agent 的行为。
    // 只报数字不喊停的话，agent 会读成「第 3 次尝试」而不是「这条路死了」。
    const text = brief([
      start({ ts: "s1", agentId: "a1" }),
      end({ ts: "e1", agentId: "a1", ok: false, errorClass: "protocol" }),
    ]);
    expect(text).toContain("不要再重复同一条路");
    expect(text).toContain("换思路或换执行器");
  });

  it("只压给重修轮看：首轮（无任何事实）返回空串让调用方不拼这段", () => {
    expect(brief([])).toBe("");
  });
});
