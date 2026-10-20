import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ToolRunner } from "../electron/chat/tool-runner";
import { CommandPolicy } from "../electron/sandbox/command-policy";

/**
 * 交互式会话的安全边界。全部用**真子进程 / 真文件系统**，不 mock：
 * - 环境最小化：模型写的脚本打印不到宿主的 provider key；
 * - 读路径：密钥文件与指向项目外的链接必须读不到；
 * - 中止：停止会话必须真的杀掉在跑的命令，而不是只把界面置灰。
 */
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-sec-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // 临时目录清理失败不改变断言结论
    }
  }
});

function runner(root: string, overrides: Partial<ConstructorParameters<typeof ToolRunner>[0]> = {}): ToolRunner {
  return new ToolRunner({ rootAbs: root, approvalPolicy: "never", ...overrides });
}

const call = (name: "read_file" | "run_command" | "grep_files", args: Record<string, unknown>) =>
  ({ id: `t-${name}`, name, args }) as const;

describe("chat 工具层安全边界", () => {
  it("run_command 看不到宿主的 provider key（默认 scopedEnv）", async () => {
    const root = project();
    fs.writeFileSync(path.join(root, "print-env.js"), 'process.stdout.write(String(process.env.SENSENOVA_API_KEY ?? "missing"));\n');
    const previous = process.env.SENSENOVA_API_KEY;
    process.env.SENSENOVA_API_KEY = "TEST_ENV_LEAK_SENTINEL";
    try {
      const result = await runner(root).run(
        call("run_command", { command: "node", args: ["print-env.js"] }) as never,
      );
      expect(result.ok).toBe(true);
      expect(result.output).toBe("missing");
      expect(result.output).not.toContain("TEST_ENV_LEAK_SENTINEL");
    } finally {
      if (previous === undefined) delete process.env.SENSENOVA_API_KEY;
      else process.env.SENSENOVA_API_KEY = previous;
    }
  });

  it("read_file 拒绝 .env，但允许 .env.example 文档模板", async () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".env"), "TEST_ENV_FILE_SENTINEL=1\n");
    fs.writeFileSync(path.join(root, ".env.example"), "SENSENOVA_API_KEY=\n");
    const r = runner(root);
    const denied = await r.run(call("read_file", { path: ".env" }) as never);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("不允许读取");
    const allowed = await r.run(call("read_file", { path: ".env.example" }) as never);
    expect(allowed.ok).toBe(true);
    expect(allowed.output).toContain("SENSENOVA_API_KEY=");
  });

  it("read_file / grep_files 不跟随项目内链接读到项目外", async () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-outside-"));
    const link = path.join(root, "escape");
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_SECRET\n");
      try {
        fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return; // 没有创建链接的权限；Linux CI 会真跑这几条断言
      }
      try {
        const r = runner(root);
        const read = await r.run(call("read_file", { path: "escape/secret.txt" }) as never);
        expect(read.ok).toBe(false);
        const grep = await r.run(call("grep_files", { pattern: "OUTSIDE_SECRET" }) as never);
        expect(grep.output).not.toContain("OUTSIDE_SECRET");
      } finally {
        if (process.platform === "win32") fs.rmdirSync(link);
        else fs.unlinkSync(link);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("会话中止会真的杀掉在跑的命令（不是只把状态置灰）", async () => {
    const root = project();
    fs.writeFileSync(path.join(root, "sleep.js"), "setTimeout(() => {}, 5000);\n");
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await runner(root).run(
        call("run_command", { command: "node", args: ["sleep.js"] }) as never,
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("中止");
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      clearTimeout(timer);
    }
  });

  it("已中止的 signal 不会再启动命令", async () => {
    const root = project();
    fs.writeFileSync(path.join(root, "touch.js"), "require('node:fs').writeFileSync('ran.txt','x');\n");
    const result = await runner(root).run(
      call("run_command", { command: "node", args: ["touch.js"] }) as never,
      { signal: AbortSignal.abort() },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("未执行");
    expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
  });

  it("命令策略的 denyMore 在工具层生效（策略文件不是摆设）", async () => {
    const root = project();
    const result = await runner(root, { commandPolicy: new CommandPolicy({ denyMore: ["node"] }) }).run(
      call("run_command", { command: "node", args: ["-v"] }) as never,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("禁止");
  });
});
