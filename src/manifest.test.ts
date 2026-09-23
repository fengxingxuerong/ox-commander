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
