import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  exampleManifest,
  parseAgentManifest,
  parseAgentManifestList,
} from "../electron/agents/manifest-schema";
import { buildAdaptersFromManifests, loadManifestDir, tokenResolver } from "../electron/agents/manifest-loader";
import { CliAgentAdapter } from "../electron/agents/cli-agent";
import { HttpBridgeAdapter } from "../electron/agents/http-bridge";

function validCodex() {
  return {
    id: "codex-cli",
    displayName: "Codex CLI",
    adapter: "cli",
    entry: { kind: "cli", command: "codex", argsTemplate: ["exec", "--cd", "{{projectRoot}}"] },
    capabilities: {
      roles: ["backend-dev"],
      zoneGlobs: ["src/**"],
      supports: ["read", "edit"],
      artifactKinds: ["files"],
      maxConcurrency: 2,
      selfIsolated: true,
    },
  };
}

describe("parseAgentManifest", () => {
  it("accepts a well-formed manifest and fills defaults", () => {
    const m = parseAgentManifest(validCodex());
    expect(m.id).toBe("codex-cli");
    expect(m.adapter).toBe("cli");
    expect(m.source).toBe("declared");
    expect(m.enabled).toBeUndefined();
  });

  it("accepts the documented example", () => {
    expect(() => parseAgentManifest(exampleManifest())).not.toThrow();
  });

  it("reports every issue at once", () => {
    try {
      parseAgentManifest({ id: "bad id!", adapter: "nope", capabilities: { roles: ["wizard"], zoneGlobs: [] } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestValidationError);
      const issues = (e as ManifestValidationError).issues.join("|");
      expect(issues).toContain("id");
      expect(issues).toContain("adapter");
      expect(issues).toContain("roles");
      expect(issues).toContain("zoneGlobs");
    }
  });

  it("requires an entry for cli/http adapters", () => {
    expect(() => parseAgentManifest({ ...validCodex(), entry: undefined })).toThrow(/entry/);
    expect(() =>
      parseAgentManifest({ ...validCodex(), adapter: "http-bridge", entry: { kind: "cli", command: "x", argsTemplate: [] } }),
    ).toThrow(/http/);
  });

  it("defaults a local-llm manifest to a builtin entry", () => {
    const m = parseAgentManifest({
      id: "local",
      displayName: "Local",
      adapter: "local-llm",
      capabilities: validCodex().capabilities,
    });
    expect(m.entry).toEqual({ kind: "builtin", provider: "sensenova" });
  });

  it("validates credential shapes", () => {
    const withEnv = parseAgentManifest({ ...validCodex(), credential: { kind: "env", envVar: "CODEX_TOKEN" } });
    expect(withEnv.credential).toEqual({ kind: "env", envVar: "CODEX_TOKEN" });
    const exec = parseAgentManifest({
      ...validCodex(),
      credential: { kind: "execToken", command: "codex", args: ["auth", "token"], cacheTtlMs: 1000 },
    });
    expect(exec.credential).toMatchObject({ kind: "execToken", cacheTtlMs: 1000 });
    expect(() => parseAgentManifest({ ...validCodex(), credential: { kind: "magic" } })).toThrow(/credential.kind/);
  });

  it("validates limits and priority", () => {
    expect(() => parseAgentManifest({ ...validCodex(), limits: { runDeadlineMs: 10 } })).toThrow(/runDeadlineMs/);
    const m = parseAgentManifest({ ...validCodex(), limits: { idleTimeoutMs: 5000 }, priority: -3 });
    expect(m.limits).toEqual({ idleTimeoutMs: 5000 });
    expect(m.priority).toBe(-3);
  });

  it("accepts a single object or an array, indexing the errors", () => {
    expect(parseAgentManifestList(validCodex())).toHaveLength(1);
    expect(parseAgentManifestList([validCodex(), { ...validCodex(), id: "second" }])).toHaveLength(2);
    try {
      parseAgentManifestList([validCodex(), { id: "x", adapter: "cli", capabilities: { roles: [], zoneGlobs: [] } }]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ManifestValidationError).issues.join()).toContain("[1]");
    }
  });
});

describe("loadManifestDir", () => {
  function withDir(files: Record<string, string>, fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-agentsd-"));
    try {
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, "utf8");
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns nothing for a missing directory", () => {
    expect(loadManifestDir(path.join(os.tmpdir(), "ox-does-not-exist-xyz")).manifests).toEqual([]);
  });

  it("loads json files, ignores .example.json, and reports bad files without failing", () => {
    withDir(
      {
        "codex.json": JSON.stringify(validCodex()),
        "broken.json": "{ not json",
        "invalid.json": JSON.stringify({ id: "no-caps" }),
        "codex.example.json": JSON.stringify(validCodex()),
      },
      (dir) => {
        const { manifests, errors } = loadManifestDir(dir);
        expect(manifests.map((m) => m.id)).toEqual(["codex-cli"]);
        expect(manifests[0]!.source).toBe("agents.d");
        expect(errors.map((e) => e.file).sort()).toEqual(["broken.json", "invalid.json"]);
      },
    );
  });

  it("accepts a file declaring several agents", () => {
    withDir(
      { "many.json": JSON.stringify([validCodex(), { ...validCodex(), id: "trae-cli" }]) },
      (dir) => {
        expect(loadManifestDir(dir).manifests.map((m) => m.id)).toEqual(["codex-cli", "trae-cli"]);
      },
    );
  });
});

describe("buildAdaptersFromManifests", () => {
  it("builds a CLI adapter for a cli manifest", () => {
    const { adapters, skipped } = buildAdaptersFromManifests([parseAgentManifest(validCodex())]);
    expect(skipped).toEqual([]);
    expect(adapters[0]).toBeInstanceOf(CliAgentAdapter);
    expect(adapters[0]!.meta.id).toBe("codex-cli");
  });

  it("builds an HTTP adapter for an http manifest", () => {
    const m = parseAgentManifest({
      id: "workbuddy",
      displayName: "WorkBuddy",
      adapter: "http-bridge",
      entry: { kind: "http", baseUrl: "http://127.0.0.1:9999" },
      capabilities: validCodex().capabilities,
    });
    const { adapters } = buildAdaptersFromManifests([m]);
    expect(adapters[0]).toBeInstanceOf(HttpBridgeAdapter);
  });

  it("把 entry 上的可选字段透传给 HTTP 适配器（pollMs 等）", () => {
    // manifest-loader 用一长串 `...(x ? { x } : {})` 构造适配器选项。
    // `pollMs` 那一条此前没有任何断言：改成 `===` 后它会被静默丢掉，
    // 适配器回落默认轮询间隔 —— 远端进度到看板的延迟被悄悄改掉，不报任何错。
    //
    // 断言方式说明：`HttpBridgeAdapter` 没有公开读取选项的访问器，
    // 而 `constructor(private opts)` 的 private 只是编译期约束，
    // 运行时该字段就是适配器持有的配置 —— 直接读它是这里唯一能落到
    // "manifest 的值真的到了适配器"这一事实上的办法。
    const m = parseAgentManifest({
      id: "workbuddy",
      displayName: "WorkBuddy",
      adapter: "http-bridge",
      entry: {
        kind: "http",
        baseUrl: "http://127.0.0.1:9999",
        runsPath: "/v1/runs",
        pollMs: 250,
      },
      capabilities: validCodex().capabilities,
    });
    const { adapters } = buildAdaptersFromManifests([m]);
    const opts = (adapters[0] as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.pollMs).toBe(250);
    expect(opts.runsPath).toBe("/v1/runs");
    expect(opts.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("skips local-llm manifests: those adapters are compiled in", () => {
    const m = parseAgentManifest({
      id: "local",
      displayName: "Local",
      adapter: "local-llm",
      capabilities: validCodex().capabilities,
    });
    const { adapters, skipped } = buildAdaptersFromManifests([m]);
    expect(adapters).toEqual([]);
    expect(skipped[0]!.reason).toContain("内置适配器");
  });

  it("builds every manifest in the list — the per-kind branches `continue`, they do not `break`", () => {
    // Both branches end with `continue`. Flipping either to `break` drops every
    // manifest after that point: no adapter is built AND nothing lands in
    // `skipped`, so an agent disappears with no signal at all.
    //
    // The single-manifest cases above cannot tell the two apart — with one
    // element, `continue` and `break` are the same thing.
    const cli = parseAgentManifest(validCodex());
    const http = parseAgentManifest({
      id: "workbuddy",
      displayName: "WorkBuddy",
      adapter: "http-bridge",
      entry: { kind: "http", baseUrl: "http://127.0.0.1:9999" },
      capabilities: validCodex().capabilities,
    });
    const local = parseAgentManifest({
      id: "local",
      displayName: "Local",
      adapter: "local-llm",
      capabilities: validCodex().capabilities,
    });
    const { adapters, skipped } = buildAdaptersFromManifests([cli, http, local]);
    expect(adapters.map((a) => a.meta.id)).toEqual(["codex-cli", "workbuddy"]);
    expect(adapters[0]).toBeInstanceOf(CliAgentAdapter);
    expect(adapters[1]).toBeInstanceOf(HttpBridgeAdapter);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe("local");
  });
});

describe("tokenResolver", () => {
  it("returns undefined for non-execToken credentials", async () => {
    expect(await tokenResolver({ kind: "none" })()).toBeUndefined();
  });

  it("reads the token from stdout", async () => {
    const resolve = tokenResolver({
      kind: "execToken",
      command: process.execPath,
      args: ["-e", "console.log('tok-123')"],
    });
    expect(await resolve()).toBe("tok-123");
  });

  it("resolves to undefined when the command fails", async () => {
    const resolve = tokenResolver({
      kind: "execToken",
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
    });
    expect(await resolve()).toBeUndefined();
  });

  it("resolves to undefined when the command is missing", async () => {
    const resolve = tokenResolver({ kind: "execToken", command: "ox-missing-binary-xyz", args: [] });
    expect(await resolve()).toBeUndefined();
  });
});

/**
 * 下面这一组来自 site 逐位点审计（manifest-schema.ts 13 处存活）。
 *
 * 这是**清单校验**：它决定一个 agent 能不能被接单。三个 helper
 * （`str` / `num` / `stringArray`）都是"要么干净地报错、要么放行"的结构，
 * 而既有用例只喂**类型正确但取值非法**的输入（负数的 runDeadlineMs、
 * 空白字符串……），从没喂过**类型就不对**的（把数字塞进字符串字段、
 * 把字符串塞进数组字段）。于是"多条件或"里靠后的那几个条件从来没被求值 ——
 * 改坏后要么抛 TypeError（诊断价值归零），要么把非法值放行（校验形同虚设）。
 */
describe("parseAgentManifest · 类型错误的输入要被干净拒绝", () => {
  it("[40] 数字塞进字符串字段：报校验错误，不是 TypeError", () => {
    // 第 40 行 `typeof v !== "string" || v.trim() === ""`。改成 `&&` 后
    // `true && (5).trim()` 会抛 **TypeError** —— 调用方拿到的是崩溃堆栈，
    // 而不是"哪个字段错了"的可读诊断（清单校验的全部价值就在这句诊断）。
    expect(() => parseAgentManifest({ ...validCodex(), displayName: 5 })).toThrowError(
      /displayName 必须是非空字符串/,
    );
  });

  it("[50] 数字字段的三个条件逐个生效（字符串 / Infinity / 负数）", () => {
    // 第 50 行 `typeof v !== "number" || !Number.isFinite(v) || v < min`。
    // 既有用例只覆盖"负数"（第三个条件）；前两个任一改成 `&&` 之后
    // **字符串 "5000" 或 Infinity 会被当成合法数值放行** ——
    // 类型污染一路流到运行时（定时器拿到字符串、比较得到 NaN）。
    const cases: Array<[unknown, string]> = [
      ["5000", "必须是不小于 1000 的数字"],
      [Number.POSITIVE_INFINITY, "必须是不小于 1000 的数字"],
      [-1, "必须是不小于 1000 的数字"],
    ];
    for (const [bad, want] of cases) {
      const label = "runDeadlineMs=" + String(bad);
      expect(
        () => parseAgentManifest({ ...validCodex(), limits: { runDeadlineMs: bad } }),
        label,
      ).toThrowError(new RegExp(want));
    }
  });

  it("[80] 字符串塞进数组字段：报校验错误，不是 TypeError", () => {
    // 第 80 行 `!Array.isArray(v) || v.some(...)`。改成 `&&` 后
    // `true && "backend-dev".some(...)` 抛 TypeError。`roles` / `zoneGlobs` /
    // `supports` 都走这个 helper，一个类型笔误就能让整份清单崩在堆栈里。
    expect(() =>
      parseAgentManifest({
        ...validCodex(),
        capabilities: { ...validCodex().capabilities, roles: "backend-dev" },
      }),
    ).toThrowError(/roles 必须是字符串数组/);
  });

  it("[59] 布尔字段为 false 时必须保留，不能被静默丢掉", () => {
    // 第 59 行是 bool helper 入口的 `if (v === undefined || v === null) return undefined;`。
    // 改成 `!==` 后该条件**恒真**（一个值不可能同时不等于 undefined 和 null），
    // 于是**所有布尔字段都被吞掉** —— `enabled: false` 变成缺省，
    // 一个被显式停用的 agent 会回到默认启用状态。
    const m = parseAgentManifest({ ...validCodex(), enabled: false });
    expect(m.enabled).toBe(false);
  });

  it("[223][225][257] 三个可选字段在给出时都要原样保留", () => {
    // `...(x !== undefined ? { x } : {})` 这三处的 `!==` 改成 `===` 后，
    // 字段在**给出时反而被丢掉**：runDeadlineMs 回落默认超时、
    // maxStdoutBytes 回落默认上限（大日志被截断）、enabled 回落默认启用。
    // 三种都是"配置写了但不生效"，而且不报错。
    const m = parseAgentManifest({
      ...validCodex(),
      limits: { runDeadlineMs: 12_345, maxStdoutBytes: 4096 },
      enabled: false,
    });
    expect(m.limits?.runDeadlineMs).toBe(12_345);
    expect(m.limits?.maxStdoutBytes).toBe(4096);
    expect(m.enabled).toBe(false);
  });
});

describe("parseAgentManifest · local-llm 的 entry 约束", () => {
  function localLlm(entry?: unknown) {
    return {
      id: "local",
      displayName: "Local",
      adapter: "local-llm",
      ...(entry === undefined ? {} : { entry }),
      capabilities: validCodex().capabilities,
    };
  }

  it("[153] 不写 entry 时接受（默认 builtin），不抛 TypeError", () => {
    // 第 153 行 `raw !== undefined && isObj(raw) && raw.kind !== "builtin"`。
    // 第一个 `&&` 改成 `||` 之后，`raw` 为 undefined 时会继续求值
    // `raw.kind` → **TypeError**。而"不写 entry"正是最常见的写法
    //（内置适配器不需要 entry），于是最普通的一份清单也会崩。
    const m = parseAgentManifest(localLlm());
    expect(m.entry).toEqual({ kind: "builtin", provider: "sensenova" });
  });

  it("[153] 显式写 kind: builtin 也要接受", () => {
    // `raw.kind !== "builtin"` 改成 `===` 之后，**正是合法的 builtin 被拒绝**。
    const m = parseAgentManifest(localLlm({ kind: "builtin" }));
    expect(m.entry).toEqual({ kind: "builtin", provider: "sensenova" });
  });

  it("[153] 写别的 kind 时拒绝（这条约束本身要真的生效）", () => {
    // `raw !== undefined` 改成 `===` 后整条件恒假 → **约束彻底失效**，
    // local-llm 配上 cli 的 entry 会被放行：运行时按 builtin 走，
    // 而清单里写的 command / argsTemplate 全部被静默忽略。
    expect(() => parseAgentManifest(localLlm({ kind: "cli", command: "codex" }))).toThrowError(
      /entry.kind 必须是 "builtin"/,
    );
  });
});

describe("parseAgentManifest · envTemplate 与未知 adapter", () => {
  it("[175] envTemplate 必须是 string→string 对象", () => {
    // 第 175 行 `!isObj(envTemplateRaw) || Object.values(envTemplateRaw).some((v) => typeof v !== "string")`。
    // 两个 `||` 各自改坏都有具体后果：
    //  - 第一个改 `&&`：非对象（比如字符串）会被 `Object.values` 拆成字符数组，
    //    每个字符都是 string → 校验通过，**非对象 envTemplate 被放行**；
    //  - 第二个改 `===`：对象里塞数字值时不再报错，**数字会被当成要注入的环境变量值**。
    expect(() =>
      parseAgentManifest({
        ...validCodex(),
        entry: { ...validCodex().entry, envTemplate: "K=V" },
      }),
    ).toThrowError(/envTemplate 必须是 string→string 对象/);
    expect(() =>
      parseAgentManifest({
        ...validCodex(),
        entry: { ...validCodex().entry, envTemplate: { K: 5 } },
      }),
    ).toThrowError(/envTemplate 必须是 string→string 对象/);
  });

  it("[243] adapter 未知时不再去校验 entry（entry 语义由具体适配器定义）", () => {
    // 第 243 行 `adapter && ADAPTERS.has(adapter) ? parseEntry(...) : undefined`。
    // `&&` 改成 `||` 之后，**未知 adapter 也会走进 parseEntry**，
    // 落进最后那个 http-bridge 分支，于是额外冒出一条
    // `entry.kind 必须是 "http"` —— 用户被引到错误的 adapter 上找问题。
    let message = "";
    try {
      parseAgentManifest({ ...validCodex(), adapter: "wishful", entry: {} });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("未知");
    expect(message).not.toContain("entry.kind 必须是");
  });
});
