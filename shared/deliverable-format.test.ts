import { describe, expect, it } from "vitest";
import {
  buildOutputRules,
  extractJson,
  parseDeliverable,
  parseFileBlocks,
  resolveDeliverablePath,
  zoneWriteRule,
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

  // 2026-09-27 变异门禁新纳入本模块后抓到的存活点：`summary` 分支的 continue 改
  // break 无人发现。现实形态：模型偶尔先吐总结再补文件块。若解析器把它当成
  // 「循环结束」，后面的块整段丢失 —— 表现为 files 变空、上层回退 JSON、最终报
  // "两种格式都无法解析"，真实原因被埋掉。所以断言 summary 之后仍有块被解析到，
  // 而不是只断言 summary 本身。
  it("summary 出现在文件块之前时，后面的块照旧解析（break 与 continue 的分野）", () => {
    const text = [
      "===OXSUMMARY=== 先给总结再交付",
      "===OXFILE after.js===",
      "AFTER",
      "===OXEND===",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.summary).toBe("先给总结再交付");
    expect(out.files).toEqual([{ path: "after.js", content: "AFTER" }]);
  });

  it("summary 出现在两个文件块之间时，第二个块不被吞掉", () => {
    const text = [
      "===OXFILE first.js===",
      "FIRST",
      "===OXEND===",
      "===OXSUMMARY=== 小结",
      "===OXFILE second.js===",
      "SECOND",
      "===OXEND===",
    ].join("\n");
    const out = parseFileBlocks(text);
    expect(out.files.map((f) => f.path)).toEqual(["first.js", "second.js"]);
    expect(out.summary).toBe("小结");
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

  // 下面四条是 2026-09-27 把本模块纳入变异门禁后抓到的存活点，全落在「回退 JSON
  // 的验收条件」上：`&& → ||` / `=== → !==` 一放宽，形状不对的 JSON 会被当成合法
  // 交付物往下传 —— 写盘阶段才会炸，届时已经分不清是模型写错还是平台放行错。

  it("files 不是数组时不算交付（漏了方括号的 JSON）", () => {
    const text = JSON.stringify({ files: "src/loomy/a.js", summary: "我是字符串不是数组" });
    expect(() => parseDeliverable(text)).toThrow(/JSON/);
  });

  it("files 为空数组时不算交付（有该字段但没内容）", () => {
    expect(() => parseDeliverable(JSON.stringify({ files: [], summary: "空" }))).toThrow(/JSON/);
  });

  it("summary 不是字符串时按缺省处理而不是原样透传", () => {
    const text = JSON.stringify({
      files: [{ path: "src/loomy/b.js", content: "B" }],
      summary: 42,
    });
    expect(parseDeliverable(text).summary).toBe("");
  });

  it("extractJson 对「有 } 无 {」与「有 { 无 }」都报同一条根因", () => {
    expect(() => extractJson("} 前面只有右括号 {")).toThrow(/响应中没有 JSON 对象/);
    expect(() => extractJson("{ 后面没有右括号")).toThrow(/响应中没有 JSON 对象/);
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

  it("路径示范带完整 zone 前缀（预检实测：'zone 内的相对路径'会被模型理解成相对 zone，必须钉死基准）", () => {
    expect(rules).toContain(`===OXFILE ${ZONE}/xxx.js===`);
  });

  it("明确说明无需转义（这是新格式的核心卖点）", () => {
    expect(rules).toMatch(/无需.*转义|不要.*转义|原样/);
  });

  it("禁止文件内容出现 ===OX 开头的行（解析器的防误伤前提）", () => {
    expect(rules).toMatch(/===OX/);
    expect(rules).toMatch(/禁止|不要|不得/);
  });
});

describe("resolveDeliverablePath", () => {
  it("相对 zone 的路径补上 zone 前缀（预检实测模型会写 hello.js）", () => {
    expect(resolveDeliverablePath("hello.js", "src/loomy")).toBe("src/loomy/hello.js");
  });

  it("已是 zone 内完整路径原样返回", () => {
    expect(resolveDeliverablePath("src/loomy/hello.js", "src/loomy")).toBe("src/loomy/hello.js");
  });

  it("反斜杠归一为正斜杠", () => {
    expect(resolveDeliverablePath("src\\loomy\\hello.js", "src/loomy")).toBe("src/loomy/hello.js");
    expect(resolveDeliverablePath("hello.js", "src\\loomy")).toBe("src/loomy/hello.js");
  });

  it("绝对路径原样返回（交给 assertWritable 拒绝，不在此放行）", () => {
    expect(resolveDeliverablePath("C:\\evil\\x.js", "src/loomy")).toBe("C:\\evil\\x.js");
  });

  // POSIX 根与 UNC 两条路：Windows 本机只有盘符形态会走到，若三条判定里最后一
  // 个 `||` 被改成 `&&`，前两种形态仍成立、只有 `/` 开头与 UNC 静默降级成"拼上
  // zone 前缀"—— 于是一条绝对路径被当成相对路径写进 zone 里，逃逸判定的最后
  // 一道守门不是在错的地方报错，而是干脆不发生。
  it("POSIX 根绝对路径与 UNC 同样原样返回（不能只认盘符）", () => {
    expect(resolveDeliverablePath("/etc/passwd", "src/loomy")).toBe("/etc/passwd");
    expect(resolveDeliverablePath("\\\\server\\share\\x.js", "src/loomy")).toBe(
      "\\\\server\\share\\x.js",
    );
  });

  it("路径穿越不在此处理（拼前缀后仍含 ..，由 assertWritable 拒绝）", () => {
    expect(resolveDeliverablePath("../evil.js", "src/loomy")).toBe("src/loomy/../evil.js");
  });

  it("zone 自身（空文件名场景）原样保留", () => {
    expect(resolveDeliverablePath("src/loomy", "src/loomy")).toBe("src/loomy");
  });
});

/**
 * 2026-09-27 --real 演习实测：规划官会划出**文件级 zone**（t1 的 zone 是
 * src/core/csv.js 这个文件本身），而旧示范把 zone 一律当目录（
 * `===OXFILE ${zone}/xxx.js===`），模型照示范写出 src/core/csv.js/index.js
 * —— 内容 7/7 全对却因路径不合约败掉验收。本组用例钉住文件级 zone 的
 * 三面约定：示范、归一、措辞。
 */
describe("文件级 zone（zone 本身就是要交付的文件）", () => {
  const FILE_ZONE = "src/core/csv.js";

  it("resolveDeliverablePath: zone/ 子路径归一为 zone 本身（文件里没有子文件）", () => {
    expect(resolveDeliverablePath("src/core/csv.js/index.js", FILE_ZONE)).toBe(FILE_ZONE);
  });

  it("resolveDeliverablePath: 裸文件名也归一为 zone（模型只给了 index.js）", () => {
    expect(resolveDeliverablePath("index.js", FILE_ZONE)).toBe(FILE_ZONE);
  });

  it("resolveDeliverablePath: 恰好等于 zone 时原样", () => {
    expect(resolveDeliverablePath(FILE_ZONE, FILE_ZONE)).toBe(FILE_ZONE);
  });

  it("resolveDeliverablePath: 穿越企图 fail-safe 归一到 zone（写不出 zone 以外）", () => {
    expect(resolveDeliverablePath("../evil.js", FILE_ZONE)).toBe(FILE_ZONE);
  });

  it("resolveDeliverablePath: 绝对路径原样返回（仍由 assertWritable 拒绝）", () => {
    expect(resolveDeliverablePath("C:\\evil\\x.js", FILE_ZONE)).toBe("C:\\evil\\x.js");
  });

  it("buildOutputRules: 示范直接写 zone 文件本身而非 zone/ 子路径", () => {
    const rules = buildOutputRules(FILE_ZONE);
    expect(rules).toContain(`===OXFILE ${FILE_ZONE}===`);
    expect(rules).not.toContain(`===OXFILE ${FILE_ZONE}/`);
  });

  it("buildOutputRules: 说明 zone 是文件不是目录", () => {
    expect(buildOutputRules(FILE_ZONE)).toMatch(/一个文件|文件本身|不是目录/);
  });

  it("zoneWriteRule: 文件级 zone 的措辞指向文件本身", () => {
    const rule = zoneWriteRule(FILE_ZONE);
    expect(rule).toContain(FILE_ZONE);
    expect(rule).toMatch(/文件/);
    expect(rule).not.toMatch(/目录内/);
  });

  it("zoneWriteRule: 目录级 zone 维持目录措辞（回归）", () => {
    const rule = zoneWriteRule("src/loomy");
    expect(rule).toContain("src/loomy");
    expect(rule).toMatch(/目录/);
  });

  it("目录级 zone 的示范与归一行为不变（回归）", () => {
    expect(buildOutputRules("src/loomy")).toContain("===OXFILE src/loomy/xxx.js===");
    expect(resolveDeliverablePath("hello.js", "src/loomy")).toBe("src/loomy/hello.js");
  });
});
