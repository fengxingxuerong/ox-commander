import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveChatRuntime } from "../electron/chat/runtime";
import { normalizeProjectConfig } from "../shared/project-config";
import { DEFAULT_SETTINGS } from "../shared/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-runtime-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function write(rel: string, text: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return abs;
}

function project(name: string): string {
  const abs = path.join(root, name);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

describe("normalizeProjectConfig · 非对象整份忽略", () => {
  it("null / 数组 / 原始值都不被当成配置：必须报「必须是一个 JSON 对象」", () => {
    for (const bad of [null, [], "x", 42, true]) {
      const r = normalizeProjectConfig(bad);
      expect(r.config).toEqual({ version: 1 });
      expect(r.issues.join()).toContain("JSON 对象");
    }
  });

  it("数组里的坏元素剔除后继续处理后面的合法值（不是遇到一个就整段放弃）", () => {
    const r = normalizeProjectConfig({
      version: 1,
      approvalCommands: [42, "npm", "  ", "git"],
    });
    expect(r.config.approvalCommands).toEqual(["git", "npm"]);
    expect(r.issues.join()).toContain("2 个非字符串/空条目");
  });
});

describe("resolveChatRuntime（项目指令 + 配置 + 策略）", () => {
  it("项目配置覆盖档位/审批/轮次，policy.d 与全局策略取并集，约定进 system prompt", () => {
    const proj = project("full");
    const home = project("home");
    const globalPolicy = project("global-policy");
    write("home/.ox/AGENTS.md", "全局偏好：回答用中文");
    write("full/AGENTS.md", "项目约定：不要改 dist");
    write("full/.ox/config.json", JSON.stringify({
      version: 1,
      sandboxMode: "read-only",
      approvalPolicy: "untrusted",
      approvalCommands: ["npm"],
      maxTurns: 7,
    }));
    write("full/.ox/policy.d/deny.json", JSON.stringify({
      version: 1,
      denyCommands: ["node"],
      approvalCommands: ["node"],
      forbidRead: ["secrets/**"],
    }));
    write("global-policy/g.json", JSON.stringify({
      version: 1,
      approvalCommands: ["git"],
      denyNpmSubcommands: ["publish"],
    }));

    const runtime = resolveChatRuntime({
      rootAbs: proj,
      homeDir: home,
      globalPolicyDir: globalPolicy,
      settings: { ...DEFAULT_SETTINGS, approvalCommands: ["curl"] },
    });

    expect(runtime.mode).toBe("read-only");
    expect(runtime.approvalPolicy).toBe("untrusted");
    expect(runtime.maxTurns).toBe(7);
    expect(runtime.approvalCommands).toEqual(["curl", "git", "node", "npm"]);
    expect(runtime.systemPrompt).toContain("全局偏好：回答用中文");
    expect(runtime.systemPrompt).toContain("项目约定：不要改 dist");
    expect(runtime.commandPolicy.check("node", []).ok).toBe(false);
    expect(runtime.commandPolicy.check("npm", ["publish"]).ok).toBe(false);
    expect(runtime.pathPolicy.assertReadable(".env")).toBe(false);
    expect(runtime.pathPolicy.assertReadable(".env.example")).toBe(true);
    expect(runtime.pathPolicy.assertReadable("secrets/key.txt")).toBe(false);
    expect(runtime.issues).toEqual([]);
  });

  it("线程级 profile 压过项目配置与全局设置，并进入签名", () => {
    const proj = project("profile");
    write("profile/.ox/config.json", JSON.stringify({
      version: 1,
      sandboxMode: "read-only",
      approvalPolicy: "untrusted",
    }));
    const settings = { ...DEFAULT_SETTINGS, sandboxMode: "workspace-write" as const, approvalPolicy: "on-request" as const };
    const base = resolveChatRuntime({ rootAbs: proj, settings });
    const overridden = resolveChatRuntime({
      rootAbs: proj,
      settings,
      profile: { mode: "danger-full-access", approvalPolicy: "never" },
    });
    expect(overridden.mode).toBe("danger-full-access");
    expect(overridden.approvalPolicy).toBe("never");
    expect(overridden.signature).not.toBe(base.signature);
  });

  it("线程级线路（provider/model）进入签名，换模型会重建会话", () => {
    const proj = project("model");
    const settings = { ...DEFAULT_SETTINGS };
    const base = resolveChatRuntime({ rootAbs: proj, settings });
    const pinned = resolveChatRuntime({
      rootAbs: proj,
      settings,
      profile: {
        mode: "workspace-write",
        approvalPolicy: "on-request",
        providerId: "deepseek",
        model: "deepseek-chat",
      },
    });
    expect(pinned.signature).not.toBe(base.signature);
    expect(
      resolveChatRuntime({ rootAbs: proj, settings, profile: { mode: "workspace-write", approvalPolicy: "on-request" } })
        .signature,
    ).toBe(base.signature);
  });

  it("策略/约定变化会让签名变化（宿主据此重建会话）", () => {
    const proj = project("signature");
    write("signature/.ox/policy.d/a.json", JSON.stringify({ version: 1, denyCommands: ["node"] }));
    write("signature/AGENTS.md", "约定一");
    const settings = { ...DEFAULT_SETTINGS };
    const first = resolveChatRuntime({ rootAbs: proj, settings });
    const again = resolveChatRuntime({ rootAbs: proj, settings });
    expect(again.signature).toBe(first.signature);

    write("signature/.ox/policy.d/a.json", JSON.stringify({ version: 1, denyCommands: ["npm"] }));
    const changedPolicy = resolveChatRuntime({ rootAbs: proj, settings });
    expect(changedPolicy.signature).not.toBe(first.signature);

    write("signature/AGENTS.md", "约定二");
    const changedPrompt = resolveChatRuntime({ rootAbs: proj, settings });
    expect(changedPrompt.signature).not.toBe(changedPolicy.signature);
    expect(changedPrompt.systemPrompt).toContain("约定二");
  });

  it("策略指纹遇到不可读目录继续扫后面的目录（不是 break 掉整张表）", () => {
    const proj = project("fingerprint");
    write("fingerprint/.ox/policy.d/a.json", JSON.stringify({ version: 1, denyCommands: ["node"] }));
    const notADir = write("not-a-dir.txt", "x");
    const settings = { ...DEFAULT_SETTINGS };
    const first = resolveChatRuntime({ rootAbs: proj, settings, globalPolicyDir: notADir });
    // 语义不变、字节数变化：describePolicy 相同，只有文件指纹能区分两次构建。
    write("fingerprint/.ox/policy.d/a.json", JSON.stringify({ version: 1, denyCommands: ["node"], padding: "x".repeat(20) }));
    const second = resolveChatRuntime({ rootAbs: proj, settings, globalPolicyDir: notADir });
    expect(second.signature).not.toBe(first.signature);
  });

  it("坏项目配置整份忽略并说破，不静默改档位", () => {
    const proj = project("bad-config");
    write("bad-config/.ox/config.json", JSON.stringify({ version: 99, sandboxMode: "danger-full-access" }));
    const runtime = resolveChatRuntime({ rootAbs: proj, settings: { ...DEFAULT_SETTINGS } });
    expect(runtime.mode).toBe(DEFAULT_SETTINGS.sandboxMode);
    expect(runtime.approvalPolicy).toBe(DEFAULT_SETTINGS.approvalPolicy);
    expect(runtime.issues.some((i) => i.includes("版本 99"))).toBe(true);
  });

  it("非法的项目配置字段被逐条拒绝，合法字段仍然生效", () => {
    const proj = project("partial-config");
    write("partial-config/.ox/config.json", JSON.stringify({
      version: 1,
      sandboxMode: "read-only",
      approvalPolicy: "sometimes",
      maxTurns: 0,
    }));
    const runtime = resolveChatRuntime({ rootAbs: proj, settings: { ...DEFAULT_SETTINGS } });
    expect(runtime.mode).toBe("read-only");
    expect(runtime.approvalPolicy).toBe(DEFAULT_SETTINGS.approvalPolicy);
    expect(runtime.issues.some((i) => i.includes("approvalPolicy 无效"))).toBe(true);
    expect(runtime.issues.some((i) => i.includes("maxTurns 无效"))).toBe(true);
  });
});
