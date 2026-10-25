import { describe, expect, it } from "vitest";
import { previewPartitionOf } from "../shared/preview-isolation";

/**
 * 预览 profile 的派生判据（C3 剩余半，2026-10-25）。
 *
 * 这个函数只有一处判据，但它是"隔离"这个词的全部内容：映射错了，两个项目的预览就共用
 * 一份 cookie，而界面上看不出任何异常。所以断言分四类：本仓库 id 形态、字符集白名单、
 * 长度上限、以及"没有身份就拒绝"。
 */
describe("previewPartitionOf · 项目 id → 预览 profile", () => {
  it("store 铸造的 id 形态映射到带前缀的 partition，同一 id 永远同一结果", () => {
    expect(previewPartitionOf("p-1761000000000-1")).toBe("persist:ox-preview-p-1761000000000-1");
    // 稳定性是承重的：不稳定则"登录一次、之后都登录着"不成立。
    expect(previewPartitionOf("p-1-2")).toBe(previewPartitionOf("p-1-2"));
    // 不同项目必须落在不同 profile 上，否则隔离只是同一份 profile 的假象。
    expect(previewPartitionOf("p-1-1")).not.toBe(previewPartitionOf("p-1-2"));
  });

  it("字符集白名单：字母、数字、连字、下划线收，别的字符一个都不收", () => {
    for (const ok of ["a", "Z", "0", "p-1", "p_1", "A-z_0", "9-_"]) {
      expect(previewPartitionOf(ok), ok).toBe(`persist:ox-preview-${ok}`);
    }
    // 空格 / 路径分隔符 / 冒号 / 点 / 换行 / 百分号编码 / 非 ASCII 全拒 ——
    // partition 名会变成磁盘上的目录名（`userData/Partitions/<name>`）。
    for (const bad of ["p 1", "p/1", "p\\1", "p:1", "p.1", "..", "p\n1", "p%2f", "项目"]) {
      expect(previewPartitionOf(bad), bad).toBeUndefined();
    }
  });

  it("长度上限：64 字符收，65 字符拒", () => {
    const atLimit = "p".repeat(64);
    expect(previewPartitionOf(atLimit)).toBe(`persist:ox-preview-${atLimit}`);
    expect(previewPartitionOf("p".repeat(65))).toBeUndefined();
  });

  it("空串与非字符串都不是身份：一律拒，不退化成共享 profile", () => {
    for (const bad of ["", 42, null, undefined, {}, ["p-1-1"]]) {
      expect(previewPartitionOf(bad), String(bad)).toBeUndefined();
    }
  });
});
