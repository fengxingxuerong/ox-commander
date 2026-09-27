import { describe, expect, it } from "vitest";
import {
  buildOutputRules,
  parseDeliverable,
  parseFileBlocks,
} from "./deliverable-format";

/**
 * 2026-09-26 实弹演习 t1（CSV 解析器）四发超时的根因治理：
 * 旧交付格式要求模型把完整代码文件内容嵌进 JSON 字符串（引号/反斜杠/换行
 * 全部转义），引号密集型任务（CSV 的引号规则本身就是业务逻辑）转义负担
 * 极重，生成本身逼近/超过桥的单次尝试时限。新格式（OXFILE 分隔符原文块）
 * 消掉转义层，JSON 格式保留为回退。
 */

const ZONE = "src/loomy";

describe("parseFileBlocks", () => {
  it("解析单个文件块：路径与原文", () => {
    const text = [
      "===OXFILE src/loomy/hello.js===",
      "module.exports = () => 'hi';",
      "===OXEND===",
      "===OXSUMMARY=== 写了问候模块",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files).toEqual([
      { path: "src/loomy/hello.js", content: "module.exports = () => 'hi';" },
    ]);
    expect(out.summary).toBe("写了问候模块");
  });

  it("解析多个文件块且保持出现顺序", () => {
    const text = [
      "===OXFILE a.js===",
      "A",
      "===OXEND===",
      "===OXFILE src/sub/b.js===",
      "B1",
      "B2",
      "===OXEND===",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files.map((f) => f.path)).toEqual(["a.js", "src/sub/b.js"]);
    expect(out.files[1].content).toBe("B1\nB2");
  });

  it("引号、反斜杠、模板字符串原样保留（无需转义——本格式的存在意义）", () => {
    const line = 'const s = "a \\"b\\""; const re = /,\\s*/; const t = `x${1}`;';
    const text = ["===OXFILE c.js===", line, "===OXEND==="].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files[0].content).toBe(line);
  });

  it("CRLF 行尾归一为 LF，空行与中文原样保留", () => {
    const text = "===OXFILE zh.js===\r\n你好\r\n\r\n世界\r\n===OXEND===\r\n";
    const out = parseFileBlocks(text);
    expect(out.files[0].content).toBe("你好\n\n世界");
  });

  it("未知 ===OX 开头行视为内容（防误伤文件正文）", () => {
    const text = [
      "===OXFILE d.js===",
      "// ===OXTAG=== 这行不是控制符",
      "===OXEND===",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files[0].content).toBe("// ===OXTAG=== 这行不是控制符");
  });

  it("块之间的空行与解释文字被忽略", () => {
    const text = [
      "好的，下面是交付：",
      "",
      "===OXFILE e.js===",
      "E",
      "===OXEND===",
      "",
      "以上。",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files).toEqual([{ path: "e.js", content: "E" }]);
  });

  it("没有 summary 时返回空字符串", () => {
    const text = ["===OXFILE f.js===", "F", "===OXEND==="].join("\n");
    expect(parseFileBlocks(text).summary).toBe("");
  });

  it("无任何文件块时返回空数组（不抛，交上层回退）", () => {
    expect(parseFileBlocks("这只是句解释").files).toEqual([]);
  });

  it("未闭合的块抛错（截断的半份代码不如明确失败进修复轮）", () => {
    const text = ["===OXFILE g.js===", "G1", "G2"].join("\n");
    expect(() => parseFileBlocks(text)).toThrow(/未闭合/);
  });

  it("空内容块抛错（模型挣扎的残迹要给出明确根因）", () => {
    const text = ["===OXFILE h.js===", "===OXEND==="].join("\n");
    expect(() => parseFileBlocks(text)).toThrow(/空内容/);
  });
});

describe("parseDeliverable", () => {
  it("分隔符格式优先：合法块直接采用", () => {
    const text = [
      "===OXFILE a.js===",
      "A",
      "===OXEND===",
      "===OXSUMMARY=== ok",
    ].join("\n");
    const out = parseDeliverable(text);
    expect("files" in out && out.files[0].path).toBe("a.js");
  });

  it("旧 JSON 格式回退可用（模型不听话时接得住）", () => {
    const text = JSON.stringify({
      files: [{ path: "src/loomy/j.js", content: "J" }],
      summary: "json",
    });
    const out = parseDeliverable(text);
    expect("files" in out && out.files[0].path).toBe("src/loomy/j.js");
  });

  it("markdown 围栏包裹的 JSON 也能回退解析", () => {
    const text = [
      "```json",
      JSON.stringify({ files: [{ path: "k.js", content: "K" }], summary: "s" }),
      "```",
    ].join("\n");
    const out = parseDeliverable(text);
    expect("files" in out && out.files[0].path).toBe("k.js");
  });

  it("两种格式都解析失败时抛出含两种格式名的聚合错误", () => {
    expect(() => parseDeliverable("完全不是交付物")).toThrow(/OXFILE.*JSON|JSON.*OXFILE/s);
  });

  it("块未闭合且 JSON 也没有时抛出未闭合错误", () => {
    expect(() => parseDeliverable("===OXFILE x.js===\nX1\nX2")).toThrow(/未闭合/);
  });
});

describe("buildOutputRules", () => {
  const rules = buildOutputRules(ZONE);

  it("包含三个控制行模板与 zone 路径提示", () => {
    expect(rules).toContain("===OXFILE ");
    expect(rules).toContain("===OXEND===");
    expect(rules).toContain("===OXSUMMARY===");
    expect(rules).toContain(ZONE);
  });

  it("明确说明无需转义（这是新格式的核心卖点）", () => {
    expect(rules).toMatch(/无需.*转义|不要.*转义|原样/);
  });

  it("禁止文件内容出现 ===OX 开头的行（解析器的防误伤前提）", () => {
    expect(rules).toMatch(/===OX/);
    expect(rules).toMatch(/禁止|不要|不得/);
  });
});
