import { describe, expect, it } from "vitest";
import { createLoopDetector, LoopDetector } from "../electron/sandbox/loop-detector";

describe("LoopDetector（循环输出检测，2026-10-11 竞品刷新）", () => {
  const LINE = "error: module not found: ./src/core/csv/index.js";

  it("[1] 连续相同长行到达阈值即触发，返回那行与次数", () => {
    const d = new LoopDetector({ threshold: 3, minLineLength: 4 });
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toBeUndefined();
    const finding = d.observe(LINE);
    expect(finding).toEqual({ repeatedLine: LINE, count: 3 });
  });

  it("[2] 一条不同的长行出现即重数——正常推进的输出不误报", () => {
    const d = new LoopDetector({ threshold: 3, minLineLength: 4 });
    d.observe(LINE);
    d.observe(LINE);
    d.observe("different line, also long enough to count here");
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toEqual({ repeatedLine: LINE, count: 3 });
  });

  it("[3] 短行跳过且不清零——夹在重复行之间的进度碎屑不算打断", () => {
    const d = new LoopDetector({ threshold: 3, minLineLength: 16 });
    d.observe(LINE);
    d.observe("ok");
    d.observe("...");
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toEqual({ repeatedLine: LINE, count: 3 });
  });

  it("[4] 短于 minLineLength 的行本身永远不触发", () => {
    const d = new LoopDetector({ threshold: 2, minLineLength: 16 });
    for (let i = 0; i < 10; i += 1) {
      expect(d.observe("waiting…")).toBeUndefined();
    }
  });

  it("[5] trim 后逐字相同才计数；行内数字不同就是不同行（带时间戳的心跳是活着的证据）", () => {
    const d = new LoopDetector({ threshold: 2, minLineLength: 4 });
    expect(d.observe(`  ${LINE}  `)).toBeUndefined();
    // 同一行但带序号：不改写数字，v1 刻意不抹平——逐字不变才是卡死的形状
    expect(d.observe(`${LINE} #2`)).toBeUndefined();
    // 不同行重置计数：LINE 要重新连续出现 2 次才触发
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toEqual({ repeatedLine: LINE, count: 2 });
  });

  it("[6] 事件文本可含多行，逐行喂入（触发发生在到达阈值的那一行）", () => {
    const d = new LoopDetector({ threshold: 3, minLineLength: 4 });
    expect(d.observe(`${LINE}\n${LINE}`)).toBeUndefined();
    // 第 3 行（跨过 \r\n）到达阈值即返回，次数是 3 不是 4
    expect(d.observe(`${LINE}\r\n${LINE}`)).toEqual({ repeatedLine: LINE, count: 3 });
  });

  it("[7] 触发后保持触发（幂等），后续同文本仍返回发现", () => {
    const d = new LoopDetector({ threshold: 2, minLineLength: 4 });
    d.observe(LINE);
    expect(d.observe(LINE)?.count).toBe(2);
    expect(d.observe(LINE)?.count).toBe(3);
    expect(d.observe(LINE)?.count).toBe(4);
  });

  it("[8] 默认参数：threshold 8 / minLineLength 16", () => {
    const d = new LoopDetector();
    for (let i = 0; i < 7; i += 1) expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)?.count).toBe(8);
  });

  it("[9] threshold 下限 2——配 1 不会退化成'任何行都触发'", () => {
    const d = new LoopDetector({ threshold: 1, minLineLength: 4 });
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)?.count).toBe(2);
  });

  it("[10] createLoopDetector：false 显式关闭，缺省开启，配置透传", () => {
    expect(createLoopDetector(false)).toBeUndefined();
    expect(createLoopDetector()).toBeInstanceOf(LoopDetector);
    const d = createLoopDetector({ threshold: 2, minLineLength: 4 })!;
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe(LINE)).toBeDefined();
  });

  it("[11] 多行事件里短行在前：跳过但不截断——同一文本里后面的长行仍参与计数", () => {
    const d = new LoopDetector({ threshold: 3, minLineLength: 16 });
    expect(d.observe(LINE)).toBeUndefined();
    expect(d.observe("ok")).toBeUndefined();
    // 关键形状：一条事件文本 = 短行 + 重复行。短行若用 break 截断整条文本，
    // 后面的长行就被丢掉，计数停在 1 —— 正常推进与卡死从此分不出来。
    expect(d.observe(`...\n${LINE}`)).toBeUndefined();
    expect(d.observe(LINE)).toEqual({ repeatedLine: LINE, count: 3 });
  });
});
