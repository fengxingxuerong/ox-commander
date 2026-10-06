import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  auditReceipt,
  buildReceipt,
  canonicalReceiptPayload,
  compareChecks,
  formatReceiptLine,
  pairConflict,
  receiptTaskStatus,
  replayableCommands,
  sealReceipt,
  verifyReceiptFingerprint,
  type DeliveryReceipt,
  type ReceiptCheck,
  type ReceiptConflict,
  type ReceiptTask,
} from "../shared/delivery-receipt";

function task(id: string, status: ReceiptTask["status"], extra: Partial<ReceiptTask> = {}): ReceiptTask {
  return { id, title: id, zone: "src", status, attempts: 1, ...extra };
}

/** 一条检查的最小构造（外部可验证那批用例大量用它）。 */
function check(kind: ReceiptCheck["kind"], ok: boolean, extra: Partial<ReceiptCheck> = {}): ReceiptCheck {
  return { kind, ok, exitCode: ok ? 0 : 1, preexisting: false, headline: "", ...extra };
}

/** 一份凭据的最小构造：只给关心的字段，其余按"空交付"填满。 */
function receipt(over: Partial<DeliveryReceipt>): DeliveryReceipt {
  return {
    outcome: "delivered",
    verified: true,
    rounds: 0,
    checks: [],
    tasks: [],
    conflicts: [],
    counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
    headline: "ok",
    ...over,
  };
}

describe("pairConflict", () => {
  it("pairs a conflict with the remedy that touches one of its paths", () => {
    const paired = pairConflict(
      { kind: "unauthorized-write", paths: ["outside/x.js"] },
      [{ action: "revert", paths: ["outside/x.js"] }],
    );
    expect(paired.remedy).toBe("revert");
  });

  it("falls back to 'none' when no remedy covers the conflict", () => {
    const paired = pairConflict(
      { kind: "unauthorized-write", paths: ["outside/x.js"] },
      [{ action: "revert", paths: ["other/y.js"] }],
    );
    expect(paired.remedy).toBe("none");
  });

  it("deduplicates and sorts paths so one conflict reads the same in every run", () => {
    const paired = pairConflict({ kind: "overlap", paths: ["b.ts", "a.ts", "b.ts"] }, []);
    expect(paired.paths).toEqual(["a.ts", "b.ts"]);
  });
});

describe("receiptTaskStatus", () => {
  it("reports a user-skipped task as skipped even though it is also marked done", () => {
    // 用户跳过这条路径同样会把任务加进"已完成"集合（它已不需要再做）——
    // 先判完成会把"人放弃的"报成"做出来的"。
    expect(receiptTaskStatus({ skipped: true, done: true })).toBe("skipped");
  });

  it("reports a task with a successful outcome that is not landed yet as pending", () => {
    // 全员重跑会清掉完成记录；那种任务的旧成功结果还在，但它这轮还没重派完。
    expect(receiptTaskStatus({ skipped: false, done: false, outcomeOk: true })).toBe("pending");
  });

  it("reports a dispatched-but-failed task as failed", () => {
    expect(receiptTaskStatus({ skipped: false, done: false, outcomeOk: false })).toBe("failed");
  });

  it("reports a task that never ran as pending, not failed", () => {
    expect(receiptTaskStatus({ skipped: false, done: false })).toBe("pending");
  });

  /**
   * `status` 与 `outcomeOk` 必须讲同一个故事（2026-10-05 分流审计）。
   *
   * 缺陷：`ReceiptTask` 里**原本没有 `outcomeOk` 字段**，
   * 而 `orchestrator.ts:463` 把 `...(outcome ? { outcomeOk: outcome.ok } : {})`
   * 展开进那个对象 —— TypeScript **静默丢弃**了它。于是真实凭据里
   * `outcomeOk` **从来就不存在**：
   *
   *   tasks[0] = {"id":"A","status":"done","attempts":2,"agentId":"c-bridge",…}
   *                                     ↑ 没有 outcomeOk
   *
   * `grep outcomeOk` 全仓只有 6 处命中、**零消费侧**，所以这个丢失从未被���现。
   * 写它那行的注释说"没有派发结果时不给 outcomeOk"，听上去是承诺 ——
   * 实际是**从没兑现过的承诺**。
   */
  it("status 与 outcomeOk 不许互相打脸（failed 必有 outcomeOk=false）", () => {
    // 这条钉的是**归并规则**本身：任何一个能算出 failed 的形状，
    // 都必须同时给出"这次派发失败了"这个事实。
    const cases: Array<[string, Parameters<typeof receiptTaskStatus>[0], boolean | undefined]> = [
      ["派发失败", { skipped: false, done: false, outcomeOk: false }, false],
      ["从未派发", { skipped: false, done: false }, undefined],
      ["派发成功但未落地", { skipped: false, done: false, outcomeOk: true }, true],
      ["跳过", { skipped: true, done: true, outcomeOk: false }, false],
      ["完成", { skipped: false, done: true, outcomeOk: true }, true],
    ];
    for (const [name, input, expectedOk] of cases) {
      const status = receiptTaskStatus(input);
      // failed 蕴含"这次派发失败"，其余状态不许这么断言
      if (status === "failed") expect(input.outcomeOk, name).toBe(false);
      if (expectedOk !== undefined) expect(input.outcomeOk, name).toBe(expectedOk);
    }
  });
});

describe("buildReceipt", () => {
  it("reports a verified delivery with the check and task counts", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [task("t1", "done"), task("t2", "skipped")],
      conflicts: [],
    });
    expect(r.counts).toMatchObject({ total: 2, done: 1, skipped: 1, failed: 0, pending: 0 });
    expect(r.headline).toContain("已交付");
    expect(r.headline).toContain("1/2 个任务完成");
    // 跳过数必须出现在结论里：少一个任务却说"全完成"是误导。
    expect(r.headline).toContain("跳过 1 个");
  });

  it("keeps 'delivered' and 'verified' independent when nothing was actually checked", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: false,
      unverifiedReason: "没有配置任何验证命令，也没有冒烟样本运行过",
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(r.verified).toBe(false);
    // 字段本身也要断言：只断言 headline 时，"凭据里少了这个字段"是看不出来的
    // （headline 走的是另一处取值），而宿主正是靠这个字段解释"为什么没验过"。
    expect(r.unverifiedReason).toBe("没有配置任何验证命令，也没有冒烟样本运行过");
    expect(r.headline).toContain("未经构建/测试验证");
    expect(r.headline).toContain("没有配置任何验证命令");
  });

  it("omits the reason key entirely when there is nothing to explain", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    // 字段即承诺：给一个 `undefined` 的键会让宿主分不清"没配理由"与"配了空理由"。
    expect("unverifiedReason" in r).toBe(false);
  });

  it("names the blocking reason on a blocked run", () => {
    const r = buildReceipt({
      outcome: "blocked",
      verified: false,
      unverifiedReason: "重修 3 轮后验证仍未通过",
      rounds: 3,
      checks: [{ kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "2 failed" }],
      tasks: [task("t1", "failed"), task("t2", "pending")],
      conflicts: [],
    });
    expect(r.headline).toContain("未交付");
    expect(r.headline).toContain("1 个失败");
    expect(r.headline).toContain("1 个未启动");
    expect(r.counts.checksFailed).toBe(1);
  });

  /**
   * 任务全做出来、只有验证红着时，凭据必须说清是**验证**没过（2026-10-05）。
   *
   * 缺陷：blocked 的"为什么"只从任务账里找（failed / pending），于是这个形状下
   * 两个数都是 0，兜底话术顶上来，而同一句的前半截是"2/2 个任务完成"：
   *
   *   未交付：2/2 个任务完成，仍有任务未完成，重修 1 轮。   ← 自相矛盾
   *
   * 这不是边角：`checksFailed>0 && failed==0 && pending==0` 是**最普通的一种红**
   * （代码写完了，构建/测试没过）。实测真实 run 就是这个形状，而那条分支此前
   * **一条断言都没有**（grep「仍有任务未完成」零命中）。
   */
  it("任务全做完但验证红着：说的是「验证命令未通过」，不是「仍有任务未完成」", () => {
    const r = buildReceipt({
      outcome: "blocked",
      verified: false,
      rounds: 1,
      checks: [{ kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "2 failed" }],
      tasks: [task("t1", "done"), task("t2", "done")],
      conflicts: [],
    });
    // 前半截与后半截不许打架
    expect(r.headline).toContain("2/2 个任务完成");
    expect(r.headline).not.toContain("仍有任务未完成");
    expect(r.headline).toContain("1 条验证命令未通过");
  });

  it("blocked 的兜底话术不该在真实形状里出现（把两类失败都穷举）", () => {
    // 穷举 failed / pending / checksFailed 八个组合：只要有任何一项 >0，
    // 凭据就必须说出是哪一项，不许退回兜底。
    for (let mask = 0; mask < 8; mask++) {
      const failed = mask & 1 ? 1 : 0;
      const pending = mask & 2 ? 1 : 0;
      const checksFailed = mask & 4 ? 1 : 0;
      const tasks = [
        ...(failed ? [task("t1", "failed")] : []),
        ...(pending ? [task("t2", "pending")] : []),
        ...(failed || pending ? [] : [task("t1", "done")]),
      ];
      const r = buildReceipt({
        outcome: "blocked",
        verified: false,
        rounds: 0,
        checks: checksFailed
          ? [{ kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "boom" }]
          : [],
        tasks,
        conflicts: [],
      });
      expect(r.headline, `mask=${mask}`).not.toContain("仍有任务未完成");
      if (checksFailed) expect(r.headline, `mask=${mask}`).toContain("验证命令未通过");
      if (failed) expect(r.headline, `mask=${mask}`).toContain("1 个失败");
      if (pending) expect(r.headline, `mask=${mask}`).toContain("1 个未启动");
    }
  });

    /**
   * 「条验证命令通过」这个说法本身要成立。
   *
   * 这一句在 `delivered && verified` 分支上，而引擎只在验证通过时才交付 ——
   * 所以按设计 `checks` 全绿，`checks.length` 恰好等于"通过的条数"。
   * **但那只是调用方的自觉，凭据自己并不校验。** 任何一处 bug 让红项混进
   * 一份 delivered 凭据，这句话就会变成"3 条验证命令通过"而实际只有 2 条绿 ——
   * 又是一次自相矛盾，只是方向相反。
   *
   * 这里先把"全绿时两数相等"钉住（真实不变量），反注入把 `checks.length`
   * 换成 `filter(ok).length` 时必须仍然是绿的 —— 若它红了，说明我把一个
   * 等价重写当成了缺陷，那比漏抓更糟。
   */
  it("全绿时「共 N 条」与「N 条通过」是同一个数", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [
        { kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "" },
        { kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" },
      ],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(r.headline).toContain("2 条验证命令通过");
    expect(r.headline).toContain("1/1 个任务完成");
    expect(r.checks.filter((c) => c.ok).length).toBe(r.checks.length);
  });

  it("headline 里的每个数字都必须能在 counts 里找到（凭据不自相矛盾）", () => {
    // 这条是上面两条要守的不变量本身：headline 是给人读的那一句，
    // 它引用的每个数字都必须来自这份凭据自己的字段。
    const shapes: Array<Parameters<typeof buildReceipt>[0]> = [
      { outcome: "blocked", verified: false, rounds: 2, checks: [{ kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "x" }], tasks: [task("t1", "done"), task("t2", "pending")], conflicts: [] },
      { outcome: "blocked", verified: false, rounds: 0, checks: [], tasks: [task("t1", "failed")], conflicts: [] },
      { outcome: "delivered", verified: true, rounds: 1, checks: [{ kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "" }], tasks: [task("t1", "done"), task("t2", "skipped")], conflicts: [] },
    ];
    for (const shape of shapes) {
      const r = buildReceipt(shape);
      const m = r.headline.match(/(\d+)\/(\d+) 个任务完成/);
      expect(m, r.headline).not.toBeNull();
      expect(Number(m![1])).toBe(r.counts.done);
      expect(Number(m![2])).toBe(r.counts.total);
      const skip = r.headline.match(/跳过 (\d+) 个/);
      if (skip) expect(Number(skip[1])).toBe(r.counts.skipped);
      const round = r.headline.match(/重修 (\d+) 轮/);
      if (round) expect(Number(round[1])).toBe(r.rounds);
    }
  });

  it("counts checks that were already failing before this run", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 1,
      checks: [
        { kind: "typecheck", ok: true, exitCode: 0, preexisting: true, headline: "" },
        { kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "" },
      ],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(r.counts.preexisting).toBe(1);
    expect(r.headline).toContain("1 条本次运行前就是红的");
  });

  it("carries conflicts through with sorted paths", () => {
    const conflicts: ReceiptConflict[] = [{ kind: "overlap", paths: ["b.ts", "a.ts"], remedy: "quarantine" }];
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [{ ...conflicts[0]!, paths: ["z.ts", "a.ts"] }],
    });
    expect(r.conflicts[0]!.paths).toEqual(["a.ts", "z.ts"]);
    expect(r.counts.conflicts).toBe(1);
    expect(r.headline).toContain("1 次越权");
  });

  it("projects usage without inventing a limit", () => {
    const withLimit = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
      usage: { totalTokens: 120, calls: 4, measuredCalls: 3, byModel: {}, limit: 1000 },
    });
    expect(withLimit.usage).toEqual({ totalTokens: 120, calls: 4, measuredCalls: 3, limit: 1000 });

    const without = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
      usage: { totalTokens: 120, calls: 4, measuredCalls: 4, byModel: {} },
    });
    expect(without.usage && "limit" in without.usage).toBe(false);

    const none = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    expect("usage" in none).toBe(false);
  });
});

/**
 * 越权（`unauthorized-write`）在**每一条出口**上都必须出现在 headline 里
 * （2026-10-05 conflict 账审计）。
 *
 * 缺陷：`conflictPart` 旧来只挂在 delivered 那条尾巴上。于是 blocked 时
 * 一次越权**整句里一个字都不提** —— 实测真实 run：
 *
 *   未交付：0/2 个任务完成，1 个失败、1 个未启动。改动已留在工作区，未通过门禁
 *
 * 而同一份凭据的 `conflicts[]` 里明明写着 `unauthorized-write` + `package.json`，
 * `counts.conflicts` 也是 1（**两条账都对，只有 headline 漏了**）。
 * 读者据此会当普通失败去看测试日志，而真正发生的是"智能体试图改 zone 外的文件"
 * —— 这是**安全事件**，不该只在成功路径顺带提一句。
 */
describe("越权在每一条出口上都要说", () => {
  const conflict = {
    kind: "unauthorized-write" as const,
    paths: ["package.json"],
    remedy: "revert" as const,
  };
  const greenCheck = { kind: "test" as const, ok: true, exitCode: 0, preexisting: false, headline: "" };

  it("blocked 且发生过越权：headline 必须提到", () => {
    const r = buildReceipt({
      outcome: "blocked", verified: false, rounds: 0, checks: [],
      tasks: [task("t1", "failed"), task("t2", "pending")], conflicts: [conflict],
    });
    expect(r.counts.conflicts).toBe(1);
    expect(r.headline).toContain("1 次越权");
  });

  it("delivered 且发生过越权：仍然提到（原有行为不许回退）", () => {
    const r = buildReceipt({
      outcome: "delivered", verified: true, rounds: 0,
      checks: [greenCheck], tasks: [task("t1", "done")], conflicts: [conflict],
    });
    expect(r.headline).toContain("1 次越权");
  });

  it("未验证交付那条出口也不许吞掉越权", () => {
    // 第三条出口：已交付但没验证。它此前同样没有 conflictPart ——
    // 与 blocked 是同一个疏漏的两个面，一次修齐。
    const r = buildReceipt({
      outcome: "delivered", verified: false, rounds: 0, checks: [],
      tasks: [task("t1", "done")], conflicts: [conflict],
    });
    expect(r.headline).toContain("1 次越权");
  });

  it("没有越权时不许凭空造一句（每条出口都不提）", () => {
    const blocked = buildReceipt({
      outcome: "blocked", verified: false, rounds: 0, checks: [],
      tasks: [task("t1", "failed")], conflicts: [],
    });
    expect(blocked.headline).not.toContain("越权");

    const unverified = buildReceipt({
      outcome: "delivered", verified: false, rounds: 0, checks: [],
      tasks: [task("t1", "done")], conflicts: [],
    });
    expect(unverified.headline).not.toContain("越权");

    const delivered = buildReceipt({
      outcome: "delivered", verified: true, rounds: 0,
      checks: [greenCheck], tasks: [task("t1", "done")], conflicts: [],
    });
    expect(delivered.headline).not.toContain("越权");
  });

  it("越权次数必须等于 conflicts[].length（headline 的数字都能数出来）", () => {
    for (const n of [1, 2, 3]) {
      const r = buildReceipt({
        outcome: "blocked", verified: false, rounds: 0, checks: [],
        tasks: [task("t1", "failed")],
        conflicts: Array.from({ length: n }, () => conflict),
      });
      expect(r.counts.conflicts).toBe(n);
      expect(r.headline).toContain(`${n} 次越权`);
    }
  });
});

describe("formatReceiptLine", () => {
  it("leads with the conclusion", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(formatReceiptLine(r)).toContain("[receipt]");
    expect(formatReceiptLine(r)).toContain("已交付");
  });

  it("says how many calls went unmeasured when the number is used as a bill", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [],
      usage: { totalTokens: 50, calls: 3, measuredCalls: 1, byModel: {} },
    });
    // 2 次没上报用量 ⇒ 这行必须自己说破，否则"50 tokens"读起来像全部支出。
    expect(formatReceiptLine(r)).toContain("2 次调用未上报用量");
  });
});

/**
 * 外部可验证性（P0-②）：凭据从"自述"变成"可复核"。
 *
 * 三块：① 命令必须记全（否则外部无从复跑）；② 规范序列化必须确定（否则指纹是噪声）；
 * ③ 裁决状态机五档不能并档（把"没复跑"报成"已验证"就是给自述背书的橡皮图章）。
 */
describe("canonicalReceiptPayload · 规范序列化（指纹的地基）", () => {
  const base: DeliveryReceipt = {
    outcome: "delivered",
    verified: true,
    rounds: 0,
    checks: [],
    tasks: [],
    conflicts: [],
    counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
    headline: "ok",
  };

  it("与键序无关：换个顺序造同一个对象，得到同一个字节串", () => {
    // 陷阱：对**已存在**的键重新赋值不会改变插入顺序。
    // `{...base, rounds: 2, headline: "X"}` 里 rounds/headline 已在 base 中，
    // 两个对象最终的键序其实**完全相同** —— 这样的用例是空转（取消了排序也照样绿）。
    // 要制造真实的键序差异，只能显式地按不同顺序插入键。
    const a: DeliveryReceipt = { ...base };
    const b: Record<string, unknown> = {};
    const baseAsRecord = base as unknown as Record<string, unknown>;
    for (const k of Object.keys(base).reverse()) b[k] = baseAsRecord[k];
    // 前置断言：先证明两个对象**确实**键序不同，否则本用例又退化成空转。
    expect(Object.keys(a)).not.toEqual(Object.keys(b));
    expect(canonicalReceiptPayload(a)).toBe(canonicalReceiptPayload(b as unknown as DeliveryReceipt));
  });

  it("显式赋 undefined 与缺席键等价（不给可选字段赋 undefined 就改变指纹）", () => {
    const withUndef = { ...base, unverifiedReason: undefined } as DeliveryReceipt;
    expect(canonicalReceiptPayload(withUndef)).toBe(canonicalReceiptPayload(base));
  });

  it("嵌套对象与数组也规范化（数组保序：命令顺序是语义）", () => {
    const c1 = { ...base, checks: [check("build", true), check("test", true)] };
    const c2 = { ...base, checks: [check("build", true), check("test", true)] };
    expect(canonicalReceiptPayload(c1)).toBe(canonicalReceiptPayload(c2));
    // 顺序不同 ⇒ 不同指纹（顺序本身是内容）
    const swapped = { ...base, checks: [check("test", true), check("build", true)] };
    expect(canonicalReceiptPayload(swapped)).not.toBe(canonicalReceiptPayload(c1));
  });

  /**
   * 只断言"两份输出相等"是不够的：序列化器**内部**改掉某个分支时，两边会同步变坏，
   * 用例照样绿（同 `snapshotRoot` 那类"两边都用同一个错实现"的陷阱）。
   * 所以这里钉住**字面量本身** —— 它是唯一能证明"这个字节串是对的"的写法。
   */
  it("字面量钉住：空交付的完整字节串（先钉死再谈排序）", () => {
    expect(canonicalReceiptPayload(base)).toBe(
      '{"checks":[],"conflicts":[],"counts":{"checksFailed":0,"conflicts":0,"done":0,"failed":0,' +
        '"pending":0,"preexisting":0,"skipped":0,"total":0},"headline":"ok","outcome":"delivered",' +
        '"rounds":0,"tasks":[],"verified":true}',
    );
  });

  it("字面量钉住：数组里的对象按同一规则递归（原数组元素顺序不做排序）", () => {
    const r = receipt({
      checks: [check("test", true, { command: "npm", args: ["run", "test"] })],
      tasks: [task("t1", "done")],
      conflicts: [{ kind: "unauthorized-write", paths: ["b", "a"], remedy: "revert" }],
    });
    const payload = canonicalReceiptPayload(r);
    // 对象内的键排序（args 在 command 前）
    expect(payload).toContain(
      '"checks":[{"args":["run","test"],"command":"npm","exitCode":0,"headline":"","kind":"test","ok":true,"preexisting":false}]',
    );
    // 数组**不**排序：tasks / paths 保持构造顺序
    expect(payload).toContain('"tasks":[{"attempts":1,"id":"t1","status":"done","title":"t1","zone":"src"}]');
    expect(payload).toContain('"conflicts":[{"kind":"unauthorized-write","paths":["b","a"],"remedy":"revert"}]');
  });

  it("null 值如实序列化成 null，不是抛异常（`exitCode: number | null` 是合法取值）", () => {
    const r = receipt({ checks: [check("build", false, { exitCode: null })] });
    // 把 null 误判成"非对象"或"对象"都会在这里现形：前者输出 null，后者直接崩。
    expect(canonicalReceiptPayload(r)).toContain(
      '"checks":[{"exitCode":null,"headline":"","kind":"build","ok":false,"preexisting":false}]',
    );
  });
});

describe("sealReceipt / verifyReceiptFingerprint · 盖章与复核", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("盖过章再复核 ⇒ match", () => {
    const sealed = sealReceipt(receipt({ outcome: "delivered", verified: true, rounds: 1 }), sha);
    expect(sealed.fingerprint).toBeTruthy();
    expect(verifyReceiptFingerprint(sealed, sha)).toMatchObject({ ok: true, reason: "match" });
  });

  it("改一个字就 mismatch，并同时给出期望值与实际值（可对账）", () => {
    const sealed = sealReceipt(receipt({ outcome: "delivered", verified: true, rounds: 1 }), sha);
    const tampered = { ...sealed, rounds: 2 };
    const v = verifyReceiptFingerprint(tampered, sha);
    expect(v).toMatchObject({ ok: false, reason: "mismatch" });
    expect(v.expected).toBeTruthy();
    expect(v.actual).toBe(sealed.fingerprint);
    // 期望值与实际值必须不同 —— 一样的话说明指纹没覆盖被改的字段
    expect(v.expected).not.toBe(v.actual);
  });

  it("改「通过/失败」这种承重字段也算篡改（改的正是结论本身）", () => {
    const sealed = sealReceipt({ ...receipt({ outcome: "blocked", verified: false, rounds: 0 }), checks: [check("test", false)] }, sha);
    const faked = { ...sealed, checks: [{ ...check("test", false), ok: true }] };
    expect(verifyReceiptFingerprint(faked, sha).reason).toBe("mismatch");
  });

  it("没盖章 ⇒ unsigned，不是 mismatch（没盖章 ≠ 被篡改，别诬告）", () => {
    const v = verifyReceiptFingerprint(receipt({ outcome: "delivered", verified: true, rounds: 0 }), sha);
    expect(v).toMatchObject({ ok: false, reason: "unsigned" });
    expect(v.expected).toBeUndefined();
  });

  it("盖章不改变原凭据本身（纯函数，不就地改）", () => {
    const raw = receipt({ outcome: "delivered", verified: true, rounds: 0 });
    const sealed = sealReceipt(raw, sha);
    expect(raw.fingerprint).toBeUndefined();
    expect(sealed.fingerprint).toBeTruthy();
  });

  it("不同哈希函数得到不同指纹（哈希是可注入的宿主决定）", () => {
    const r = receipt({ outcome: "delivered", verified: true, rounds: 0 });
    expect(sealReceipt(r, sha).fingerprint).not.toBe(sealReceipt(r, () => "x").fingerprint);
  });
});

describe("compareChecks · 声称 vs 复跑", () => {
  it("结论一致 ⇒ reproduced", () => {
    expect(compareChecks([check("build", true)], [{ kind: "build", ok: true, exitCode: 0 }])).toEqual([
      { kind: "build", claimed: true, observed: true, verdict: "reproduced" },
    ]);
  });

  it("凭据说通过、复跑说失败 ⇒ contradicted（凭据不可信）", () => {
    expect(compareChecks([check("build", true)], [{ kind: "build", ok: false, exitCode: 1 }])).toEqual([
      { kind: "build", claimed: true, observed: false, verdict: "contradicted" },
    ]);
  });

  it("复跑没跑到这条 ⇒ unrunnable（不是 contradicted，别诬告）", () => {
    expect(compareChecks([check("build", true)], [])).toEqual([
      { kind: "build", claimed: true, verdict: "unrunnable" },
    ]);
  });

  it("两轮验的都是失败 ⇒ 仍算 reproduced，但把退出码差异写出来", () => {
    // 同一条命令在不同机器上退出码可能不同，而"都失败"这个结论是一致的。
    const c = compareChecks(
      [{ ...check("test", false), exitCode: 1 }],
      [{ kind: "test", ok: false, exitCode: 127 }],
    );
    expect(c[0]!.verdict).toBe("reproduced");
    expect(c[0]!.note).toContain("退出码不同");
    expect(c[0]!.note).toContain("127");
  });

  it("两边都失败且退出码相同 ⇒ reproduced 且不啰嗦", () => {
    const c = compareChecks(
      [{ ...check("test", false), exitCode: 1 }],
      [{ kind: "test", ok: false, exitCode: 1 }],
    );
    expect(c[0]!.verdict).toBe("reproduced");
    expect(c[0]!.note).toBeUndefined();
  });

  it("同名检查按顺序配对，不都对着第一条比", () => {
    // 两条 test：凭据是「先败后成」，观察也是「先败后成」⇒ 两条都 reproduced。
    // 若实现改成"同名都用第一条观察"，第二条会被误判成 contradicted。
    const c = compareChecks(
      [check("test", false), check("test", true)],
      [
        { kind: "test", ok: false, exitCode: 1 },
        { kind: "test", ok: true, exitCode: 0 },
      ],
    );
    expect(c.map((x) => x.verdict)).toEqual(["reproduced", "reproduced"]);
  });

  it("观察比声称多时，多余的观察不参与（只比声称的那些）", () => {
    const c = compareChecks([check("build", true)], [
      { kind: "build", ok: true, exitCode: 0 },
      // 另一条 kind 的观察：凭据里没有对应的声称项，不该被算进来
      { kind: "smoke", ok: false, exitCode: 1 },
    ]);
    expect(c).toHaveLength(1);
  });
});

describe("replayableCommands · 只有带命令的检查能被复跑", () => {
  it("挑出带 command 的，缺席的不编命令", () => {
    const r = receipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [check("build", true, { command: "npm", args: ["run", "build"] }), check("test", true)],
    });
    expect(replayableCommands(r)).toEqual([{ kind: "build", command: "npm", args: ["run", "build"] }]);
  });

  it("空字符串命令不算可复跑（伪造一条空命令去跑等于编造观察）", () => {
    const r = receipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [check("build", true, { command: "" })],
    });
    expect(replayableCommands(r)).toEqual([]);
  });

  it("缺 args 时补空数组（不把 undefined 传进 spawn）", () => {
    const r = receipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [check("build", true, { command: "npm" })],
    });
    expect(replayableCommands(r)[0]!.args).toEqual([]);
  });
});

describe("auditReceipt · 五档裁决（不许并档）", () => {
  const match = { ok: true, reason: "match" as const };

  it("指纹不符 ⇒ tampered，且**不看**复跑结果（比的是假凭据，矛盾是伪证的产物）", () => {
    const cmp = [{ kind: "build" as const, claimed: true, observed: false, verdict: "contradicted" as const }];
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), { ok: false, reason: "mismatch" }, cmp);
    expect(a.verdict).toBe("tampered");
    expect(a.comparisons).toEqual([]); // 早退：不进比对
    expect(a.summary).toContain("被改过");
  });

  it("没盖章 ⇒ unsigned（不是被篡改）", () => {
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), { ok: false, reason: "unsigned" });
    expect(a.verdict).toBe("unsigned");
    expect(a.summary).toContain("无法判断");
  });

  it("指纹一致但一条都没复跑 ⇒ not-replayed（指纹一致 ≠ 结论为真）", () => {
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), match, []);
    expect(a.verdict).toBe("not-replayed");
    expect(a.summary).toContain("未复跑");
  });

  it("有任一条被推翻 ⇒ contradicted，且在摘要里点名是哪条", () => {
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), match, [
      { kind: "build", claimed: true, observed: true, verdict: "reproduced" },
      { kind: "test", claimed: true, observed: false, verdict: "contradicted" },
    ]);
    expect(a.verdict).toBe("contradicted");
    expect(a.summary).toContain("test");
    expect(a.summary).toContain("凭据说通过、复跑说失败");
  });

  it("全部复现 ⇒ verified（唯一能说凭据可信的档）", () => {
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), match, [
      { kind: "build", claimed: true, observed: true, verdict: "reproduced" },
    ]);
    expect(a.verdict).toBe("verified");
    expect(a.summary).toContain("复现全部 1 条");
    // 反向断言：**没有** unrunnable 时不许出现"另有 N 条无命令可比"。
    // 只断正面会漏判 —— 把 === 变异成 !== 会把"复现的条数"当成"没法比的条数"，
    // 摘要多出一句"另有 1 条无命令可比"，而正面断言照样通过。
    expect(a.summary).not.toContain("无命令可比");
  });

  it("有 unrunnable 时仍可 verified，但摘要要说清有几条没法比", () => {
    const a = auditReceipt(receipt({ outcome: "delivered", verified: true, rounds: 0 }), match, [
      { kind: "build", claimed: true, observed: true, verdict: "reproduced" },
      { kind: "test", claimed: true, verdict: "unrunnable" },
    ]);
    expect(a.verdict).toBe("verified");
    expect(a.summary).toContain("1 条无命令可比");
  });

  it("replayable 计数反映凭据里可被独立复跑的命令数", () => {
    const r = receipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [check("build", true, { command: "npm" }), check("test", true)],
    });
    expect(auditReceipt(r, match, []).replayable).toBe(1);
  });
});
