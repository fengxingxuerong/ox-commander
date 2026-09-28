import { describe, expect, it } from "vitest";
import { planBatches, skippedDescendants } from "../shared/graph";
import type { Task } from "../shared/types";

function t(id: string, deps: string[], zone = `z-${id}`): Task {
  return {
    id,
    title: id,
    description: "",
    zone,
    dependencies: deps,
    suggestedRole: "fullstack-dev",
  };
}

describe("planBatches", () => {
  it("runs independent tasks in one parallel batch", () => {
    const batches = planBatches([t("a", []), t("b", []), t("c", [])]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("serializes dependent tasks", () => {
    const batches = planBatches([t("b", ["a"]), t("a", [])]);
    expect(batches.map((b) => b[0].id)).toEqual(["a", "b"]);
  });

  it("splits same-zone tasks into separate batches", () => {
    const batches = planBatches([t("a", [], "shared"), t("b", [], "shared")]);
    expect(batches).toHaveLength(2);
  });

  it("splits OVERLAPPING zones too — the case same-name equality missed", () => {
    // 分批判据 2026-09-28 前只做字符串全等：`src` 与 `src/util` 被当成互不相干，
    // 同批并发跑就会让两个智能体写同一个文件，而越权检测看不见（每条写入都落在
    // 本批某个 zone 之内）。现在按 zonesOverlap 判。
    const batches = planBatches([t("a", [], "src"), t("b", [], "src/util")]);
    expect(batches.map((b) => b.map((x) => x.id))).toEqual([["a"], ["b"]]);
  });

  it("does not over-approximate: sibling directories still run in parallel", () => {
    // 反向守卫 —— 若把判据写成"共享任何前缀就算重叠"，这条会红，
    // 而退化成本来该有的样子（什么都串行）没人会发现。
    const batches = planBatches([t("a", [], "src/util"), t("b", [], "src/store"), t("c", [], "tests")]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("a task claiming the whole tree is alone in its batch", () => {
    const batches = planBatches([t("a", [], "."), t("b", [], "src/store"), t("c", [], "tests")]);
    // `.` 与本批任何 zone 都重叠 → a 独占第一批；b 与 c 互不重叠 → 同批并行。
    expect(batches.map((b) => b.map((x) => x.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("treats a case-differing zone as the same ground", () => {
    // Windows 上 src/Store 与 src/store 就是同一个目录；Linux 上多串行一轮只是慢。
    const batches = planBatches([t("a", [], "src/Store"), t("b", [], "src/store")]);
    expect(batches).toHaveLength(2);
  });

  it("module-shaped zone conflicts with its own module file zone", () => {
    const batches = planBatches([t("a", [], "src/duration"), t("b", [], "src/duration.js")]);
    expect(batches).toHaveLength(2);
  });

  it("defers only the conflicting task — the rest of the batch still runs together", () => {
    const batches = planBatches([t("a", [], "src"), t("b", [], "src/util"), t("c", [], "tests")]);
    expect(batches.map((b) => b.map((x) => x.id))).toEqual([["a", "c"], ["b"]]);
  });

  it("throws on dependency cycles", () => {
    expect(() => planBatches([t("a", ["b"]), t("b", ["a"])])).toThrow(/cycle/i);
  });

  it("handles diamond dependencies without duplicate execution", () => {
    const batches = planBatches([
      t("d", ["b", "c"]),
      t("b", ["a"]),
      t("c", ["a"]),
      t("a", []),
    ]);
    const flatOrder = batches.flat().map((x) => x.id);
    expect(flatOrder.indexOf("a")).toBeLessThan(flatOrder.indexOf("d"));
    expect(flatOrder).toHaveLength(4);
  });
});

describe("skippedDescendants · 被跳过的上游会传染到谁", () => {
  it("空集合没有任何后果", () => {
    const tasks = [t("a", []), t("b", ["a"])];
    expect(skippedDescendants(tasks, new Set())).toEqual(new Set());
  });

  it("跳过的任务本身不算下游，闭包沿依赖边传递", () => {
    const tasks = [t("a", []), t("b", ["a"]), t("c", ["b"])];
    const out = skippedDescendants(tasks, new Set(["a"]));
    expect([...out].sort()).toEqual(["b", "c"]);
    expect(out.has("a")).toBe(false);
  });

  it("多上游里只要有一份被跳过就算传染", () => {
    const tasks = [t("a", []), t("ok", []), t("x", ["a", "ok"])];
    expect([...skippedDescendants(tasks, new Set(["a"]))]).toEqual(["x"]);
  });

  it("菱形：一份产物缺了，两条支路与汇合点都缺", () => {
    const tasks = [t("a", []), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])];
    expect([...skippedDescendants(tasks, new Set(["a"]))].sort()).toEqual(["b", "c", "d"]);
  });

  it("上游都在（只是失败没跳过）时不传染", () => {
    const tasks = [t("a", []), t("b", ["a"])];
    expect(skippedDescendants(tasks, new Set(["nope"]))).toEqual(new Set());
  });
});
