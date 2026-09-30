import { describe, expect, it } from "vitest";
import { isLoopbackBaseUrl, remoteExecutorNote } from "../electron/agents/remote-endpoint";
import { createAgentLayer } from "../electron/agents";
import { parseAgentManifest } from "../electron/agents/manifest-schema";
import type { AgentManifest } from "../shared/agent-contract";

/**
 * 远程执行器这一格的判据：不是"能不能连"（http-bridge 本来就支持任意 baseUrl），
 * 而是**有没有说破代价** —— 远端改动不在本地工作区，越权检测与回滚对它静默失效。
 */
describe("isLoopbackBaseUrl", () => {
  it("recognises the loopback names and the whole 127/8 block", () => {
    for (const h of ["localhost", "127.0.0.1", "127.255.0.7", "0.0.0.0"]) {
      expect(isLoopbackBaseUrl(`http://${h}:8787`)).toBe(true);
    }
    // IPv6 回环必须带方括号才构成合法 URL —— 裸写 `::1` 解析不出主机，
    // 会被保守地判成"不在本机"（那是应有的方向：证明不了在本机就不给担保）。
    expect(isLoopbackBaseUrl("http://[::1]:8787")).toBe(true);
  });

  it("treats LAN addresses and hostnames as remote", () => {
    for (const base of ["http://192.168.1.9:8787", "https://runner.internal:443", "http://10.0.0.4"]) {
      expect(isLoopbackBaseUrl(base)).toBe(false);
    }
  });

  it("falls back to 'not local' when the URL cannot be parsed", () => {
    // 解析不出来就当远端：漏报（把远端当本机）会让"本地沙箱兜底"这句担保变成假的，
    // 而误报只是多说一句话。两种误判不对称，取便宜的那个。
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
  });

  it("ignores case in the host", () => {
    expect(isLoopbackBaseUrl("http://LOCALHOST:8787")).toBe(true);
  });
});

describe("remoteExecutorNote", () => {
  it("says nothing for a local bridge (its changes are inside the workspace)", () => {
    // 本机桥接（Marvis 那一类）的改动落在本地工作区 —— 沙箱与仲裁照常生效，
    // 对它们泼冷水只会淹没真正需要注意的那条。
    expect(remoteExecutorNote("marvis", "http://127.0.0.1:8787")).toBeUndefined();
  });

  it("names the agent, the address and what stops working", () => {
    const note = remoteExecutorNote("remote-runner", "http://192.168.1.9:8787")!;
    expect(note).toContain("remote-runner");
    expect(note).toContain("192.168.1.9");
    // 关键在"看不见"而不是"会报错" —— 静默失效比报错危险得多。
    expect(note).toContain("不生效");
    expect(note).toContain("看不见");
  });
});

describe("createAgentLayer · 远程执行器的边界提示", () => {
  function manifest(baseUrl: string, id = "remote-runner"): AgentManifest {
    return parseAgentManifest({
      id,
      adapter: "http-bridge",
      entry: { kind: "http", baseUrl, runsPath: "/runs", healthPath: "/health" },
      capabilities: {
        roles: ["backend-dev"],
        zoneGlobs: ["src/**"],
        supports: ["read", "edit"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: true,
      },
    });
  }

  it("announces the boundary once when a bridge points off-machine", () => {
    const events: string[] = [];
    createAgentLayer({
      manifests: [manifest("http://192.168.1.9:8787")],
      onEvent: (t) => events.push(t),
    });
    // 加载时就说，别等操作者看着"零越权"的看板以为万事大吉。
    expect(events.some((e) => e.includes("remote-runner"))).toBe(true);
    expect(events.some((e) => e.includes("不生效"))).toBe(true);
  });

  it("keeps scanning after a local bridge so a later remote one still gets announced", () => {
    const events: string[] = [];
    createAgentLayer({
      manifests: [manifest("http://127.0.0.1:8787", "local-bridge"), manifest("http://10.0.0.4:8787", "far-away")],
      onEvent: (t) => events.push(t),
    });
    // 第一个是本机 ⇒ 若这里写成 break，后面那个远端的边界就永远不会被说破
    // （它恰恰是最需要说的那个）。本机那条仍然不该被点名。
    expect(events.some((e) => e.includes("far-away"))).toBe(true);
    expect(events.some((e) => e.includes("local-bridge"))).toBe(false);
  });

  it("does not stop at a non-http declaration sitting before a remote one", () => {
    // 声明列表是混着来的（cli 与 http 同目录）。若"跳过非 http"写成中断，
    // 排在前头的 cli 声明会把后面那个远端的边界提示整个吞掉。
    const cli = parseAgentManifest({
      id: "codex-cli",
      adapter: "cli",
      entry: { kind: "cli", command: "codex", argsTemplate: ["exec"] },
      capabilities: {
        roles: ["backend-dev"],
        zoneGlobs: ["src/**"],
        supports: ["read", "edit"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: true,
      },
    });
    const events: string[] = [];
    createAgentLayer({
      manifests: [cli, manifest("http://10.0.0.4:8787", "far-away")],
      onEvent: (t) => events.push(t),
    });
    expect(events.some((e) => e.includes("far-away"))).toBe(true);
  });

  it("stays quiet for a loopback bridge", () => {
    const events: string[] = [];
    createAgentLayer({
      manifests: [manifest("http://127.0.0.1:8787")],
      onEvent: (t) => events.push(t),
    });
    expect(events.some((e) => e.includes("不生效"))).toBe(false);
  });
});
