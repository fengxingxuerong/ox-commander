import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MCP_SERVERS,
  mcpCallText,
  mcpConnectIssue,
  mcpEnvNames,
  mcpToolName,
  normalizeMcpToolDef,
  parseMcpManifest,
  parseMcpToolName,
  toMcpToolSpec,
  validateMcpArgs,
} from "../shared/mcp";
import { loadMcpManifests, mcpDirFingerprint } from "../electron/mcp/manifest";

const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mcp-contract-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

function write(dir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

describe("MCP manifest · 归一化", () => {
  it("接受最小清单，文件名可以承担 name", () => {
    const r = parseMcpManifest({ command: "npx" }, "filesystem");
    expect(r.issues).toEqual([]);
    expect(r.manifest).toMatchObject({ name: "filesystem", command: "npx", args: [], env: {} });
    expect(r.manifest?.timeoutMs).toBeGreaterThan(0);
  });

  it("显式 name/args/env/timeout 被原样保留，且 env 名排序", () => {
    const r = parseMcpManifest({
      name: "fs",
      command: "node",
      args: ["server.js", "--root", "."],
      env: { ZED: "1", ALPHA: "2" },
      timeoutMs: 5_000,
    });
    expect(r.issues).toEqual([]);
    expect(r.manifest).toMatchObject({ name: "fs", command: "node", args: ["server.js", "--root", "."], timeoutMs: 5_000 });
    expect(mcpEnvNames(r.manifest!)).toEqual(["ALPHA", "ZED"]);
  });

  it("拒绝会破坏名空间的 server 名与非法命令/参数", () => {
    expect(parseMcpManifest({ name: "a__b", command: "x" }).issues.join()).toContain("__");
    expect(parseMcpManifest({ name: "has space", command: "x" }).issues.join()).toContain("name");
    expect(parseMcpManifest({ name: "ok", command: "  " }).issues.join()).toContain("command");
    expect(parseMcpManifest({ name: "ok", command: "x", args: ["a", 2] }).issues.join()).toContain("args");
    expect(parseMcpManifest({ name: "ok", command: "x", args: "nope" }).issues.join()).toContain("args");
  });

  it("env 只收字符串值；名字不能为空/带等号；超长值被拒", () => {
    expect(parseMcpManifest({ name: "ok", command: "x", env: { A: 1 } }).issues.join()).toContain("env.A");
    expect(parseMcpManifest({ name: "ok", command: "x", env: { "": "v" } }).issues.join()).toContain("env 变量名");
    expect(parseMcpManifest({ name: "ok", command: "x", env: { "A=B": "v" } }).issues.join()).toContain("env 变量名");
    expect(parseMcpManifest({ name: "ok", command: "x", env: { A: "x".repeat(8_193) } }).issues.join()).toContain("8192");
    expect(parseMcpManifest({ name: "ok", command: "x", env: [] }).issues.join()).toContain("env 必须是对象");
  });

  it("一个坏 env 不吞掉后面的坏 env（continue 不是 break：每一处都要报出来）", () => {
    const r = parseMcpManifest({
      name: "ok",
      command: "x",
      env: { "": "v", A: 1, LONG: "x".repeat(8_193), B: 2 },
    });
    expect(r.issues).toHaveLength(4);
    expect(r.issues.join()).toContain("env.A");
    expect(r.issues.join()).toContain("8192");
    expect(r.issues.join()).toContain("env.B");
  });

  it("timeout 只接受区间内的整数", () => {
    // 1000.5 专门钉"非整数"：1.5 会被下限先挡住，测不出 Number.isInteger 那一段。
    for (const bad of [0, 999, 300_001, 1.5, 1_000.5, "1000"]) {
      expect(parseMcpManifest({ name: "ok", command: "x", timeoutMs: bad }).issues.join()).toContain("timeoutMs");
    }
    expect(parseMcpManifest({ name: "ok", command: "x", timeoutMs: 1_000 }).manifest?.timeoutMs).toBe(1_000);
    expect(parseMcpManifest({ name: "ok", command: "x", timeoutMs: 300_000 }).manifest?.timeoutMs).toBe(300_000);
  });

  it("非对象整份拒绝", () => {
    expect(parseMcpManifest(null).issues).toEqual(["清单必须是一个 JSON 对象"]);
    expect(parseMcpManifest([]).manifest).toBeUndefined();
  });
});

describe("MCP 工具名空间", () => {
  it("mcp__server__tool 可往返；第一个 __ 之后全是工具名", () => {
    expect(mcpToolName("fs", "read_file")).toBe("mcp__fs__read_file");
    expect(parseMcpToolName("mcp__fs__read_file")).toEqual({ server: "fs", tool: "read_file" });
    expect(parseMcpToolName("mcp__fs__nested__name")).toEqual({ server: "fs", tool: "nested__name" });
  });

  it("没有前缀/空 server/空工具/非法字符一律拒绝", () => {
    for (const bad of ["read_file", "mcp__", "mcp____x", "mcp__fs__", "mcp__bad server__x", "mcp__fs__bad tool"]) {
      expect(parseMcpToolName(bad), bad).toBeNull();
    }
  });

  it("工具声明缺 name 或名太长时跳过，说明也补默认值", () => {
    expect(normalizeMcpToolDef({ name: "x" }).def).toMatchObject({
      name: "x",
      description: expect.stringContaining("未提供说明"),
      inputSchema: { type: "object", properties: {} },
    });
    expect(normalizeMcpToolDef({ description: "d" }).issue).toContain("缺少 name");
    expect(normalizeMcpToolDef({ name: "x".repeat(97) }).issue).toContain("工具名不合法");
    expect(normalizeMcpToolDef({ name: "ok", description: " ", inputSchema: [] }).def?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeMcpToolDef({ name: "ok", description: "   " }).def?.description).toContain("未提供说明");
    expect(normalizeMcpToolDef({ name: "ok", description: "  查找  " }).def?.description).toBe("查找");
  });

  it("转成平台工具声明时带 server 前缀与来源说明，schema 原样保留", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"], oneOf: [] };
    const spec = toMcpToolSpec("fs", { name: "find", description: "查找", inputSchema: schema });
    expect(spec.name).toBe("mcp__fs__find");
    expect(spec.description).toContain("[MCP fs]");
    expect(spec.parameters).toBe(schema);
  });
});

describe("MCP 参数校验（宽松子集）", () => {
  const schema = {
    type: "object",
    properties: {
      text: { type: "string" },
      n: { type: "number" },
      whole: { type: "integer" },
      flag: { type: "boolean" },
      tags: { type: "array" },
      nested: { type: "object" },
      either: { type: ["string", "number"] },
      extended: { type: "oneOf-weird" },
    },
    required: ["text"],
    additionalProperties: false,
  };

  it("必填缺失、类型不符、未知参数（schema 禁止时）都报给模型", () => {
    expect(validateMcpArgs("mcp__s__t", schema, [])).toContain("必须是一个对象");
    expect(validateMcpArgs("mcp__s__t", schema, {})).toContain("缺少必填参数：text");
    expect(validateMcpArgs("mcp__s__t", schema, { text: 1 })).toContain("text 类型不对");
    expect(validateMcpArgs("mcp__s__t", schema, { text: "x", whole: 1.5 })).toContain("whole 类型不对");
    expect(validateMcpArgs("mcp__s__t", schema, { text: "x", nope: 1 })).toContain("不接受参数：nope");
  });

  it("联合类型、未知扩展类型、未声明 additionalProperties 时不制造假失败", () => {
    expect(validateMcpArgs("mcp__s__t", schema, { text: "x", either: 3 })).toBeNull();
    expect(validateMcpArgs("mcp__s__t", schema, { text: "x", extended: { any: true } })).toBeNull();
    expect(validateMcpArgs("mcp__s__t", { type: "object", properties: {} }, { free: "form" })).toBeNull();
    expect(validateMcpArgs("mcp__s__t", undefined, { free: 1 })).toBeNull();
  });

  it("数组/对象/布尔按 JSON 类型判定", () => {
    expect(validateMcpArgs("t", schema, { text: "x", tags: ["a"] })).toBeNull();
    expect(validateMcpArgs("t", schema, { text: "x", tags: "a" })).toContain("tags");
    expect(validateMcpArgs("t", schema, { text: "x", nested: {} })).toBeNull();
    expect(validateMcpArgs("t", schema, { text: "x", nested: [] })).toContain("nested");
    expect(validateMcpArgs("t", schema, { text: "x", flag: true })).toBeNull();
    expect(validateMcpArgs("t", schema, { text: "x", flag: "true" })).toContain("flag");
  });

  it("跳过无类型/非对象属性/未知参数之后继续检查后面的参数", () => {
    const skipSchema = {
      type: "object",
      properties: {
        skipped: { type: "string" },
        odd: null,
        any: {},
        n: { type: "number" },
      },
    };
    // value === undefined 跳过
    expect(validateMcpArgs("t", skipSchema, { skipped: undefined, n: "bad" })).toContain("n");
    // 非对象属性跳过
    expect(validateMcpArgs("t", skipSchema, { odd: 1, n: "bad" })).toContain("n");
    // 没有 type 的属性跳过
    expect(validateMcpArgs("t", skipSchema, { any: 1, n: "bad" })).toContain("n");
    // 未知参数（schema 不禁止）跳过
    expect(validateMcpArgs("t", { ...skipSchema, additionalProperties: true }, { free: 1, n: "bad" })).toContain("n");
    // 联合类型里只声明 string：数字要被判错（类型数组不能被过滤成空）
    expect(validateMcpArgs("t", { type: "object", properties: { only: { type: ["string"] } } }, { only: 1 })).toContain(
      "only",
    );
  });

  it("number/integer/null 的边界：NaN、字符串整数、null 各按声明判定", () => {
    const num = { type: "object", properties: { n: { type: "number" } } };
    expect(validateMcpArgs("t", num, { n: 1.5 })).toBeNull();
    expect(validateMcpArgs("t", num, { n: Number.NaN })).toContain("n");
    expect(validateMcpArgs("t", num, { n: Number.POSITIVE_INFINITY })).toContain("n");

    const int = { type: "object", properties: { n: { type: "integer" } } };
    expect(validateMcpArgs("t", int, { n: 2 })).toBeNull();
    expect(validateMcpArgs("t", int, { n: "2" })).toContain("n");
    expect(validateMcpArgs("t", int, { n: 2.5 })).toContain("n");

    const nullable = { type: "object", properties: { z: { type: "null" } } };
    expect(validateMcpArgs("t", nullable, { z: null })).toBeNull();
    expect(validateMcpArgs("t", nullable, { z: "null" })).toContain("z");
  });
});

describe("tools/call 结果展平", () => {
  it("text 段落按序拼接；isError 如实转述", () => {
    expect(
      mcpCallText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toEqual({ text: "a\nb", isError: false });
    expect(mcpCallText({ content: [{ type: "text", text: "bad" }], isError: true })).toEqual({
      text: "bad",
      isError: true,
    });
  });

  it("resource 取 text/uri；image/audio 不注入 base64", () => {
    expect(mcpCallText({ content: [{ type: "resource", resource: { text: "hello" } }] }).text).toBe("hello");
    expect(mcpCallText({ content: [{ type: "resource", resource: { uri: "file:///x" } }] }).text).toBe(
      "[resource file:///x]",
    );
    const image = mcpCallText({ content: [{ type: "image", mimeType: "image/png", data: "A".repeat(1_000) }] });
    expect(image.text).toContain("image/png");
    expect(image.text).toContain("base64 1000 字符");
    expect(image.text).not.toContain("A".repeat(50));
    expect(mcpCallText({ content: [{ type: "audio", data: "zzz" }] }).text).toContain("audio unknown");
  });

  it("坏项/空 resource 不吞掉后面的段落（continue 不是 break）", () => {
    expect(mcpCallText({ content: [null, { type: "text", text: "after-null" }] }).text).toContain("after-null");
    expect(
      mcpCallText({ content: [{ type: "resource", resource: {} }, { type: "text", text: "after-resource" }] }).text,
    ).toContain("after-resource");
    const imageThenText = mcpCallText({
      content: [
        { type: "image", mimeType: "image/png", data: "A".repeat(1_000) },
        { type: "text", text: "after-image" },
      ],
    });
    expect(imageThenText.text).toContain("after-image");
  });

  it("没有 content 时用 structuredContent 兜底；有 content 时不重复", () => {
    expect(mcpCallText({ structuredContent: { ok: 1 } }).text).toContain('"ok": 1');
    expect(mcpCallText({ content: [] }).text).toContain("没有返回内容");
    expect(mcpCallText({ content: [null, { type: "weird" }, { type: "resource", resource: {} }] }).text).toContain(
      "无法识别",
    );
    // content 已经给出正文时，structuredContent 是重复信息，不能再拼一遍。
    expect(
      mcpCallText({ content: [{ type: "text", text: "正文" }], structuredContent: { duplicate: true } }).text,
    ).toBe("正文");
    expect(mcpCallText("not-an-object")).toEqual({ text: "MCP server 返回的 result 不是对象", isError: true });
  });

  it("连接问题带 server 名与原始原因", () => {
    expect(mcpConnectIssue("fs", new Error("ENOENT"))).toBe("MCP server fs 不可用：ENOENT");
    expect(mcpConnectIssue("fs", "boom")).toContain("boom");
  });
});

describe("mcp.d 清单加载", () => {
  it("跳过 *.example.json，坏文件逐条报，重复名只留先读到的那份", () => {
    const dir = tempDir();
    write(dir, "a.json", { command: "node", args: ["a.js"] });
    write(dir, "a.example.json", { command: "ignored" });
    write(dir, "b.json", "{not json");
    // 语法合法但校验不过：它走的是"解析成功、manifest 缺席"那条 continue，
    // 与 JSON 解析失败不是同一条分支。
    write(dir, "b2.json", { args: [] });
    write(dir, "c.json", { name: "a", command: "node" });
    write(dir, "d.json", { name: "ok", command: "node", args: ["d.js"] });
    const load = loadMcpManifests(dir);
    expect(load.servers.map((s) => s.name)).toEqual(["a", "ok"]);
    expect(load.issues).toHaveLength(3);
    expect(load.issues[0]?.file).toBe("b.json");
    expect(load.issues[1]?.file).toBe("b2.json");
    expect(load.issues[2]?.message).toContain("server 名重复");
  });

  it("目录不存在不是错误；超过 server 上限的清单被跳过并说破", () => {
    expect(loadMcpManifests(path.join(tempDir(), "missing"))).toEqual({ servers: [], issues: [] });
    const dir = tempDir();
    for (let i = 0; i < MAX_MCP_SERVERS + 2; i += 1) {
      write(dir, `s${String(i).padStart(2, "0")}.json`, { command: "node" });
    }
    const load = loadMcpManifests(dir);
    expect(load.servers).toHaveLength(MAX_MCP_SERVERS);
    expect(load.issues).toHaveLength(2);
    expect(load.issues[0]?.message).toContain("上限");
  });

  it("目录指纹随文件内容变化（签名靠它触发会话重建）", () => {
    const dir = tempDir();
    write(dir, "a.json", { command: "node" });
    const first = mcpDirFingerprint(dir);
    expect(first).toHaveLength(1);
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ command: "node", args: ["x"] }), "utf8");
    expect(mcpDirFingerprint(dir)).not.toEqual(first);
    expect(mcpDirFingerprint(undefined)).toEqual([]);
    expect(mcpDirFingerprint(path.join(dir, "missing"))).toEqual([]);
  });
});
