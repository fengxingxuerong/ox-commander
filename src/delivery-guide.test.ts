import { describe, expect, it } from "vitest";
import type { DeliveryReceipt, ReceiptCheck, ReceiptTask } from "../shared/delivery-receipt";
import { deriveDeliveryGuide, startCommands, type DeliveryFact } from "../shared/delivery-guide";

function check(kind: ReceiptCheck["kind"], command?: string, args?: string[]): ReceiptCheck {
  return {
    kind,
    ok: true,
    exitCode: 0,
    preexisting: false,
    headline: "",
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
  };
}

function task(id: string, zone: string, title = id): ReceiptTask {
  return { id, title, zone, status: "done", attempts: 1 };
}

function receipt(over: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
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

const prd: DeliveryFact = { phase: "stage", stage: "PRD" };
const batch = (files: DeliveryFact["files"], extra: Partial<DeliveryFact> = {}): DeliveryFact => ({
  phase: "batch-changes",
  files,
  ...extra,
});
const receiptFact = (value?: DeliveryReceipt, extra: Partial<DeliveryFact> = {}): DeliveryFact => ({
  phase: "receipt",
  ...(value !== undefined ? { receipt: value } : {}),
  ...extra,
});

describe("deriveDeliveryGuide：运行边界", () => {
  it("空审计 → 空产物、空命令、无凭据", () => {
    expect(deriveDeliveryGuide([])).toEqual({
      artifacts: [],
      commands: [],
      totalFiles: 0,
      hasReceipt: false,
    });
  });

  it("只取最后一次 PRD 之后的批次（上一次 run 的产物不混进来）", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/old.js", op: "modify" }]),
      receiptFact(receipt({ tasks: [task("old", "src")] })),
      prd,
      batch([{ path: "src/new.js", op: "create" }]),
      receiptFact(receipt({ tasks: [task("new", "src")] })),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.artifacts[0]?.files.map((f) => f.path)).toEqual(["src/new.js"]);
  });

  it("最新一条凭据之后只有 run-start（无 PRD 的续跑）时，只取续跑的批次", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/old.js", op: "modify" }]),
      receiptFact(receipt({ checks: [check("test", "npm", ["run", "test"])], tasks: [task("t1", "src")] })),
      { phase: "run-start", taskId: "t2", zone: "src" },
      batch([{ path: "src/new.js", op: "create" }]),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.artifacts[0]?.files.map((f) => f.path)).toEqual(["src/new.js"]);
    // 新一轮还没有凭据：不能把上一轮的验收命令当成本次的。
    expect(guide.commands).toEqual([]);
  });

  it("最后一条凭据之后出现新的 PRD 时，从 PRD 起算（不带上一条 receipt）", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/old.js", op: "modify" }]),
      receiptFact(receipt({ tasks: [task("old", "src")] })),
      prd,
      { phase: "run-start", taskId: "new", zone: "src" },
    ]);
    expect(guide.artifacts).toEqual([]);
    expect(guide.totalFiles).toBe(0);
  });

  it("没有 PRD（续跑）时以最后一份凭据为界，取它之后的批次", () => {
    const guide = deriveDeliveryGuide([
      batch([{ path: "src/old.js", op: "modify" }]),
      receiptFact(receipt({ tasks: [task("old", "src")] })),
      batch([{ path: "src/new.js", op: "modify" }]),
      receiptFact(receipt({ tasks: [task("new", "src")] })),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.artifacts[0]?.files.map((f) => f.path)).toEqual(["src/new.js"]);
  });

  it("没有 PRD 也没有凭据时取全部事实", () => {
    const guide = deriveDeliveryGuide([
      { phase: "run-start", taskId: "t1", zone: "src" },
      batch([{ path: "src/a.js", op: "create" }]),
    ]);
    expect(guide.totalFiles).toBe(1);
  });

  it("不是起点阶段的 stage 记录不算运行起点", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/old.js", op: "modify" }]),
      receiptFact(receipt({ tasks: [task("old", "src")] })),
      batch([{ path: "src/mid.js", op: "modify" }]),
      { phase: "stage", stage: "VERIFICATION" },
      batch([{ path: "src/new.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(2);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/mid.js", "src/new.js"]);
  });

  it("上一次 run 没有凭据（取消/崩溃）时，新的 DEVELOPMENT 阶段是新起点", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "stage", stage: "DEVELOPMENT" },
      batch([{ path: "src/first.js", op: "modify" }]),
      { phase: "stage", stage: "DEVELOPMENT" },
      batch([{ path: "src/second.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/second.js"]);
  });

  it("PLANNING 也是起点（重新规划后不带上一次 run 的改动）", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/old.js", op: "modify" }]),
      { phase: "stage", stage: "PLANNING" },
      batch([{ path: "src/new.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/new.js"]);
  });

  it("非 stage 记录上的起点阶段名不算运行起点", () => {
    const guide = deriveDeliveryGuide([
      receiptFact(receipt()),
      batch([{ path: "src/old.js", op: "modify" }]),
      batch([], { stage: "PRD" }),
      batch([{ path: "src/new.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(2);
  });

  it("凭据记录缺少 receipt 载荷时不算边界（不会被当成一次收尾）", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/a.js", op: "modify" }]),
      receiptFact(undefined),
      batch([{ path: "src/b.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(2);
  });

  it("凭据记录缺少载荷时不会清掉此前收到的凭据与命令", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/a.js", op: "modify" }]),
      receiptFact(receipt({ checks: [check("test", "npm", ["run", "test"])] })),
      receiptFact(undefined),
    ]);
    expect(guide.commands).toEqual([
      { kind: "verify", label: "复跑 test", command: "npm", args: ["run", "test"] },
    ]);
  });
});

describe("deriveDeliveryGuide：项目过滤", () => {
  const facts: DeliveryFact[] = [
    { phase: "stage", stage: "PRD", projectId: "p-1" },
    batch([{ path: "src/a.js", op: "create" }], { projectId: "p-1" }),
    { phase: "stage", stage: "PRD", projectId: "p-2" },
    batch([{ path: "src/b.js", op: "create" }], { projectId: "p-2" }),
  ];

  it("给 projectId 时只保留该项目的记录", () => {
    const guide = deriveDeliveryGuide(facts, { projectId: "p-1" });
    expect(guide.artifacts).toEqual([]);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/a.js"]);
  });

  it("不给 projectId 时不过滤", () => {
    const guide = deriveDeliveryGuide(facts);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/b.js"]);
  });
});

describe("deriveDeliveryGuide：按任务分组", () => {
  const facts: DeliveryFact[] = [
    { phase: "stage", stage: "PRD" },
    { phase: "run-start", taskId: "api", title: "接口", zone: "src/api" },
    batch([
      { path: "src/api/users.js", op: "modify", bytes: 12 },
      { path: "docs/readme.md", op: "create" },
      { path: "outside/x.js", op: "modify" },
    ]),
    receiptFact(
      receipt({
        tasks: [task("api", "src/api", "接口"), task("docs", "docs", "文档"), task("empty", "tests", "空任务")],
      }),
    ),
  ];

  it("按 zone 归属任务，只收有改动的任务组；对不上的进 unassigned", () => {
    const guide = deriveDeliveryGuide(facts);
    expect(guide.artifacts.map((g) => [g.taskId, g.title, g.files.map((f) => f.path)])).toEqual([
      ["api", "接口", ["src/api/users.js"]],
      ["docs", "文档", ["docs/readme.md"]],
    ]);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["outside/x.js"]);
    expect(guide.totalFiles).toBe(3);
  });

  it("跨批次重复改动只保留最后一次的 op/bytes", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "run-start", taskId: "t", zone: "src" },
      batch([{ path: "src/a.js", op: "modify", bytes: 10 }]),
      batch([{ path: "src/a.js", op: "delete" }]),
    ]);
    expect(guide.totalFiles).toBe(1);
    expect(guide.artifacts[0]?.files).toEqual([{ path: "src/a.js", op: "delete" }]);
  });

  it("有字节数的文件带 bytes 键；没有字节数的文件连键都不出现", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "run-start", taskId: "t", zone: "src" },
      batch([{ path: "src/a.js", op: "modify", bytes: 10 }]),
      batch([{ path: "src/b.js", op: "delete" }]),
    ]);
    const files = guide.artifacts[0]?.files ?? [];
    expect(Object.keys(files[0]!)).toEqual(["path", "op", "bytes"]);
    expect(Object.keys(files[1]!)).toEqual(["path", "op"]);
  });

  it("无凭据时任务从 run-start 事实来；缺 title/zone 时用 id 与空 zone", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "run-start", taskId: "t1" },
      batch([{ path: "src/a.js", op: "create" }]),
    ]);
    expect(guide.artifacts).toEqual([
      { taskId: "t1", title: "t1", zone: "", files: [{ path: "src/a.js", op: "create" }] },
    ]);
  });

  it("文件级 zone 也算归属", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "run-start", taskId: "csv", zone: "src/core/csv.js" },
      batch([{ path: "src/core/csv.js", op: "modify" }]),
    ]);
    expect(guide.artifacts[0]?.taskId).toBe("csv");
  });

  it("空 id 被忽略；同一 id 的重复派发只登记一次（以首次 zone 为准）", () => {
    const guide = deriveDeliveryGuide([
      prd,
      { phase: "run-start", taskId: "" },
      { phase: "run-start", taskId: "t", zone: "src/a" },
      { phase: "run-start", taskId: "t", zone: "src/b" },
      batch([{ path: "src/a/x.js", op: "create" }, { path: "src/b/y.js", op: "create" }]),
    ]);
    expect(guide.artifacts).toHaveLength(1);
    expect(guide.artifacts[0]?.zone).toBe("src/a");
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/b/y.js"]);
  });

  it("非 run-start 记录上的 taskId 不登记任务", () => {
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/a.js", op: "create" }], { taskId: "ghost", zone: "src", title: "幽灵" }),
    ]);
    expect(guide.artifacts).toEqual([]);
    expect(guide.unassigned?.map((f) => f.path)).toEqual(["src/a.js"]);
  });

  it("非 receipt 记录携带 receipt 载荷时不参与收尾判定", () => {
    const stale = receipt({ checks: [check("test", "npm", ["run", "test"])] });
    const guide = deriveDeliveryGuide([
      prd,
      batch([{ path: "src/a.js", op: "modify" }], { receipt: stale }),
      batch([{ path: "src/b.js", op: "modify" }]),
    ]);
    expect(guide.totalFiles).toBe(2);
    expect(guide.commands).toEqual([]);
  });

  it("空路径被忽略，不占总文件数", () => {
    const guide = deriveDeliveryGuide([prd, batch([{ path: "", op: "create" }])]);
    expect(guide.totalFiles).toBe(0);
    expect(guide.unassigned).toBeUndefined();
  });
});

describe("deriveDeliveryGuide：怎么验收", () => {
  it("凭据里带命令的检查可复跑；无命令的检查不进清单；重复命令去重", () => {
    const guide = deriveDeliveryGuide([
      prd,
      receiptFact(
        receipt({
          checks: [
            check("build", "npm", ["run", "build"]),
            check("test"),
            check("test", "npm", ["run", "build"]),
            check("smoke", "node", ["smoke.js"]),
          ],
        }),
      ),
    ]);
    expect(guide.commands).toEqual([
      { kind: "verify", label: "复跑 build", command: "npm", args: ["run", "build"] },
      { kind: "verify", label: "复跑 smoke", command: "node", args: ["smoke.js"] },
    ]);
  });

  it("package.json 的 dev/start/preview/serve 成为启动命令，且与验证命令去重", () => {
    const guide = deriveDeliveryGuide(
      [
        prd,
        receiptFact(receipt({ checks: [check("test", "npm", ["run", "dev"])] })),
      ],
      { packageJson: JSON.stringify({ scripts: { dev: "vite", start: "node .", preview: "vite preview", serve: "node s.js", test: "vitest" } }) },
    );
    expect(guide.commands).toEqual([
      { kind: "verify", label: "复跑 test", command: "npm", args: ["run", "dev"] },
      { kind: "start", label: "启动 · start", command: "npm", args: ["run", "start"] },
      { kind: "start", label: "启动 · preview", command: "npm", args: ["run", "preview"] },
      { kind: "start", label: "启动 · serve", command: "npm", args: ["run", "serve"] },
    ]);
  });

  it("坏 package.json / 非对象 / scripts 非对象都只给空清单，不抛", () => {
    expect(startCommands("{oops")).toEqual([]);
    expect(startCommands("null")).toEqual([]);
    expect(startCommands("42")).toEqual([]);
    expect(startCommands(JSON.stringify({ scripts: null }))).toEqual([]);
    expect(startCommands(JSON.stringify({ scripts: "nope" }))).toEqual([]);
    expect(startCommands(undefined)).toEqual([]);
  });

  it("脚本值不是字符串或为空串时不算启动命令", () => {
    expect(startCommands(JSON.stringify({ scripts: { dev: 1, start: "   " } }))).toEqual([]);
  });
});
