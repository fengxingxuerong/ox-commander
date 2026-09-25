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
