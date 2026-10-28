import { describe, expect, it } from "vitest";
import {
  RECEIPT_STAMP_RE,
  parseReceiptFilename,
  receiptFilename,
  selectReceiptFiles,
  verdictExitCode,
  worstVerdict,
} from "../shared/receipt-lib";
import type { ReceiptVerdict } from "../shared/delivery-receipt";

/**
 * 这一组守的是凭据库的**索引与归并**（第七轮竞品吸收 · 凭据回放门）。
 *
 * 两条最坏的失败方式：
 *   1. 文件名里编造事实 —— 索引指向不存在的凭据，读的人以为它在说别的事；
 *   2. 整批的裁决定义不唯一 —— 同一叠凭据两次跑给出两个结论（那正是"不可复现"）。
 */

const FP = "a1b2c3d4" + "e".repeat(56);

describe("receiptFilename · 命名只写真事实", () => {
  it("时间戳 + 指纹前 8 位，前缀取自凭据自己", () => {
    expect(receiptFilename("20261026-221530", FP)).toBe("20261026-221530-a1b2c3d4.json");
    expect(receiptFilename("20261026-221530", "00000000" + "f".repeat(56))).toBe(
      "20261026-221530-00000000.json",
    );
  });

  it("时间戳段不合法就抛（不静默产一个走样的名字）", () => {
    for (const bad of ["2026-10-26", "20261026", "20261026-2215", "20261026-2215300", ""]) {
      expect(() => receiptFilename(bad, FP), bad).toThrow(/时间戳段不合法/);
    }
  });

  it("凭据没指纹（或不足 8 位）就抛 —— 索引不能凭空造一个前缀", () => {
    expect(() => receiptFilename("20261026-221530", undefined)).toThrow(/不能凭空造/);
    expect(() => receiptFilename("20261026-221530", "a1b2c3d")).toThrow(/不能凭空造/);
  });

  it("时间戳口径与 git-export 的 deliveryStamp 一致（同一个正则）", () => {
    expect(RECEIPT_STAMP_RE.test("20261026-221530")).toBe(true);
    expect(RECEIPT_STAMP_RE.test("20261026-22153")).toBe(false);
  });
});

describe("parseReceiptFilename · 认不出就返回 null", () => {
  it("与 receiptFilename 往返一致", () => {
    const name = receiptFilename("20261026-221530", FP);
    expect(parseReceiptFilename(name)).toEqual({ stamp: "20261026-221530", prefix: "a1b2c3d4" });
  });

  it("不认得的文件名一律 null（目录里可能有 README / .gitkeep / 别人的文件）", () => {
    for (const bad of [
      "README.md",
      ".gitkeep",
      "20261026-221530.json", // 缺指纹段
      "20261026-221530-A1B2C3D4.json", // 指纹段必须小写（我们自己写的，收紧更好查）
      "20261026-221530-a1b2c3d4.txt", // 后缀不对
      "x20261026-221530-a1b2c3d4.json", // 前缀多余
      "20261026-221530-a1b2c3d4-extra.json",
    ]) {
      expect(parseReceiptFilename(bad), bad).toBeNull();
    }
  });
});

describe("worstVerdict · 整批的裁决必须唯一且取最严重", () => {
  it("空数组 ⇒ undefined（「没有凭据」不是「通过」）", () => {
    expect(worstVerdict([])).toBeUndefined();
  });

  it("严重度序：tampered > contradicted > unsigned > not-replayed > verified", () => {
    const all: ReceiptVerdict[] = ["verified", "not-replayed", "unsigned", "contradicted", "tampered"];
    expect(worstVerdict(all)).toBe("tampered");
    expect(worstVerdict(all.filter((v) => v !== "tampered"))).toBe("contradicted");
    expect(worstVerdict(["verified", "not-replayed", "unsigned"])).toBe("unsigned");
    expect(worstVerdict(["verified", "not-replayed"])).toBe("not-replayed");
    expect(worstVerdict(["verified", "verified"])).toBe("verified");
  });

  it("与顺序无关：同一批换个顺序给，结论必须一样", () => {
    const a: ReceiptVerdict[] = ["unsigned", "tampered", "verified"];
    const b: ReceiptVerdict[] = ["verified", "unsigned", "tampered"];
    expect(worstVerdict(a)).toBe(worstVerdict(b));
  });
});

describe("verdictExitCode · 与 receipt:verify 同一张表", () => {
  it("五档各自的退出码", () => {
    expect(verdictExitCode("verified")).toBe(0);
    expect(verdictExitCode("contradicted")).toBe(2);
    expect(verdictExitCode("tampered")).toBe(3);
    expect(verdictExitCode("unsigned")).toBe(4);
    expect(verdictExitCode("not-replayed")).toBe(5);
  });

  it("只有 verified 是 0 —— 其余四档都不许绿（没复跑 ≠ 结论为真）", () => {
    const others: ReceiptVerdict[] = ["contradicted", "tampered", "unsigned", "not-replayed"];
    for (const v of others) expect(verdictExitCode(v), v).not.toBe(0);
  });
});

describe("selectReceiptFiles · 挑文件（时间倒序 / limit / 跳过不认得的）", () => {
  it("按文件名里的时间戳倒序（不是 mtime：mtime 会被 checkout 改掉）", () => {
    const { files } = selectReceiptFiles([
      "20261026-100000-aaaaaaaa.json",
      "20261026-120000-bbbbbbbb.json",
      "20261026-110000-cccccccc.json",
    ]);
    expect(files).toEqual([
      "20261026-120000-bbbbbbbb.json",
      "20261026-110000-cccccccc.json",
      "20261026-100000-aaaaaaaa.json",
    ]);
  });

  it("limit 取**最近** N 份；limit=0 取 0 份（不是「不限」）", () => {
    const names = ["20261026-100000-aaaaaaaa.json", "20261026-120000-bbbbbbbb.json"];
    expect(selectReceiptFiles(names, { limit: 1 }).files).toEqual(["20261026-120000-bbbbbbbb.json"]);
    expect(selectReceiptFiles(names, { limit: 0 }).files).toEqual([]);
  });

  it("认不出的文件名进 skipped（说破，不静默）", () => {
    const { files, skipped } = selectReceiptFiles([
      "README.md",
      "20261026-100000-aaaaaaaa.json",
      ".gitkeep",
    ]);
    expect(files).toEqual(["20261026-100000-aaaaaaaa.json"]);
    expect(skipped).toEqual(["README.md", ".gitkeep"]);
  });

  it("同一秒内的多份按名字再排一次：同一叠输入永远给同一个顺序", () => {
    const names = ["20261026-100000-bbbbbbbb.json", "20261026-100000-aaaaaaaa.json"];
    expect(selectReceiptFiles(names).files).toEqual([
      "20261026-100000-bbbbbbbb.json",
      "20261026-100000-aaaaaaaa.json",
    ]);
    // 反向输入 → 同一个顺序（否则"同一叠凭据两次跑给两个结论"）
    expect(selectReceiptFiles([...names].reverse()).files).toEqual(selectReceiptFiles(names).files);
  });
});
