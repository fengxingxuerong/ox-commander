import { describe, expect, it } from "vitest";
import { planBatches } from "../shared/graph";
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
