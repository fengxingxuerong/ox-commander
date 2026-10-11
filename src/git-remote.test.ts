import { describe, expect, it } from "vitest";
import {
  REMOTE_RE,
  deliveryRemoteArgs,
  REF_RE,
  firstUrl,
  parseChecks,
  publishDeliveryRemote,
  type GitRemoteInput,
} from "../electron/engine/git-remote";

/**
 * 注入式 runner：**按命令分发**（不是按调用顺序）—— 因为"要不要调 gh、调几次"
 * 本身就是被测行为，脚本不该替它决定。缺省：remote 列表含 origin、push 成功、
 * gh pr create 成功。
 */
function fakeRunner(
  script: Record<string, Array<{ code: number; stdout?: string; stderr?: string }>> = {},
) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: readonly string[]) => {
    // 由长到短匹配：整条命令 → `gh pr create` → `gh pr` → `gh`。
    const keys = [
      [command, ...args].join(" "),
      `${command} ${args[0] ?? ""} ${args[1] ?? ""}`.trim(),
      `${command} ${args[0] ?? ""}`.trim(),
      command,
    ];
    calls.push({ command, args: [...args] });
    for (const k of keys) {
      const next = script[k]?.shift();
      if (next) return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
    }
    return defaultFor(command, args);
  };
  return { run, calls };
}

function defaultFor(command: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  if (command === "git" && args[0] === "remote") return { code: 0, stdout: "origin\nupstream\n", stderr: "" };
  if (command === "git" && args[0] === "push") return { code: 0, stdout: "", stderr: "" };
  if (command === "gh" && args[0] === "pr" && args[1] === "create") {
    return { code: 0, stdout: "https://github.com/o/r/pull/42\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "pr" && args[1] === "checks") {
    return { code: 0, stdout: `[{"name":"verify","state":"SUCCESS"}]`, stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
}

function base(input: Partial<GitRemoteInput> = {}): GitRemoteInput {
  return {
    projectRoot: "D:/proj",
    branch: "oxcommander/delivery-20261011-120000",
    mode: "push",
    ...input,
  };
}

describe("git-remote · 自证与解析", () => {
  it("[1] 分支名不合法：一条命令都不跑（分支名是本地半边生成的，这里再校验一次）", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryRemote(base({ branch: "bad branch;rm", run }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("分支名不合法");
    expect(calls).toHaveLength(0);
  });

  it("[2] remote 名 / 基分支不合法同样先拒；字符集是刻意收紧的", async () => {
    const { run, calls } = fakeRunner();
    expect((await publishDeliveryRemote(base({ remote: "or igin", run }))).reason).toContain("远端名不合法");
    expect((await publishDeliveryRemote(base({ remote: "origin;rm -rf", run }))).reason).toContain("远端名不合法");
    expect((await publishDeliveryRemote(base({ mode: "pr", base: "ma in", run }))).reason).toContain("基分支不合法");
    expect(calls).toHaveLength(0);
    expect(REMOTE_RE.test("origin")).toBe(true);
    expect(REMOTE_RE.test("up-stream")).toBe(true);
    expect(REMOTE_RE.test("../evil")).toBe(false);
    expect(REF_RE.test("main")).toBe(true);
    expect(REF_RE.test("release/1.2")).toBe(true);
    expect(REF_RE.test("-dash-first")).toBe(false);
  });

  it("[3] checks 解析：解析不出来一律 unknown，绝不猜成绿", () => {
    expect(parseChecks("").state).toBe("unknown");
    expect(parseChecks("no checks reported").state).toBe("unknown");
    expect(parseChecks("not json").state).toBe("unknown");
    expect(parseChecks("{}").state).toBe("unknown");
    expect(parseChecks("[]").state).toBe("unknown");
    expect(parseChecks(`[{"name":"a","state":"SUCCESS"}]`).state).toBe("pass");
    expect(parseChecks(`[{"name":"a","state":"NEUTRAL"},{"name":"b","state":"SKIPPED"}]`).state).toBe("pass");
    expect(parseChecks(`[{"name":"a","state":"PENDING"}]`).state).toBe("pending");
    expect(parseChecks(`[{"name":"a","state":"IN_PROGRESS"}]`).state).toBe("pending");
    const f = parseChecks(`[{"name":"verify","state":"FAILURE"},{"name":"site","state":"ERROR"}]`);
    expect(f.state).toBe("fail");
    expect(f.failed).toEqual(["verify", "site"]);
  });

  it("[3d] 失败档逐个点名：CANCELLED / TIMED_OUT / ACTION_REQUIRED 都算失败", () => {
    // 变异锚点：git-remote.ts @149 的 `||` → `&&`。换成 && 后那一段恒假，
    // 这几个状态不再计入 failed —— 结论会从 fail 变成 pass，循环里必红。
    for (const s of ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]) {
      const r = parseChecks(`[{"name":"j","state":"${s}"}]`);
      expect(r.state).toBe("fail");
      expect(r.failed).toEqual(["j"]);
    }
  });

  it("[3e] pending 档逐个点名：一个都没跑完就不许判绿", () => {
    // 变异锚点：git-remote.ts @155 的 `||` → `&&`（整串恒假 → pending 判不出来，
    // 结论退化成 pass —— 那正是"CI 还没说绿就当我们绿了"）。
    for (const s of ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]) {
      expect(parseChecks(`[{"name":"j","state":"${s}"}]`).state).toBe("pending");
    }
  });

  it("[3b] 数组里混进 null / 非对象：跳过而不是抛错（本模块对引擎承诺永不 throw）", () => {
    // 变异锚点：`||` → `&&`（git-remote.ts @110）。`null` 的 typeof 是 "object"，
    // 换成 && 后 null 会漏过卫语句并在取 .state 时抛 TypeError —— 这条用例会红。
    expect(parseChecks(`[null, {"name":"a","state":"SUCCESS"}]`)).toEqual({ state: "pass", failed: [] });
    expect(parseChecks(`[42, "x", {"name":"a","state":"FAILURE"}]`)).toEqual({ state: "fail", failed: ["a"] });
  });

  it("[3c] checks 里混进 null：分发不崩，结论 unknown（坏数据不许被读成绿）", async () => {
    const { run } = fakeRunner({
      "gh pr": [
        { code: 0, stdout: "https://github.com/o/r/pull/9\n" },
        { code: 0, stdout: `[null]` },
        { code: 0, stdout: `[null]` },
        { code: 0, stdout: `[null]` },
      ],
    });
    const r = await publishDeliveryRemote(
      base({ mode: "pr", run, poll: { intervalMs: 5, maxPolls: 3 }, sleep: async () => undefined }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks?.state).toBe("unknown");
  });

  it("[4] PR URL 取最后一行里的 https 地址（gh 会把说明写在前面）", () => {
    expect(firstUrl("Creating pull request…\nhttps://github.com/o/r/pull/7\n")).toBe(
      "https://github.com/o/r/pull/7",
    );
    expect(firstUrl("no url here")).toBeUndefined();
  });
});

describe("git-remote · 分发路径（注入 runner）", () => {
  it("[5] 仓库没有这个远端 = 跳过不是失败（配置问题，不是分发失败）", async () => {
    const { run, calls } = fakeRunner({ "git remote": [{ code: 0, stdout: "upstream\n" }] });
    const r = await publishDeliveryRemote(base({ run }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe("no-remote");
    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("[6] 只推分支：不碰 gh，且**永不 --force**", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryRemote(base({ run, remote: "upstream" }));
    expect(r.ok).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.remote).toBe("upstream");
    const push = calls.find((c) => c.args[0] === "push")!;
    expect(push.args).toEqual(["push", "-u", "upstream", "oxcommander/delivery-20261011-120000"]);
    expect(calls.every((c) => !c.args.includes("--force"))).toBe(true);
    expect(calls.some((c) => c.command === "gh")).toBe(false);
  });

  it("[7] push 失败：ok=false 并把「凭据/权限」的可能性说破（我们不知道是哪一种）", async () => {
    const { run } = fakeRunner({
      "git push": [{ code: 1, stderr: "Permission denied (publickey)." }],
    });
    const r = await publishDeliveryRemote(base({ run }));
    expect(r.ok).toBe(false);
    expect(r.pushed).toBeUndefined();
    expect(r.reason).toContain("git push 失败");
    expect(r.reason).toContain("Permission denied");
    expect(r.reason).toContain("不碰凭据");
  });

  it("[8] mode=pr：开 PR 并解析出地址；--draft 按需带上", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryRemote(base({ mode: "pr", run, base: "release/1.2", draft: true }));
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe("https://github.com/o/r/pull/42");
    const pr = calls.find((c) => c.command === "gh")!;
    expect(pr.args.slice(0, 6)).toEqual(["pr", "create", "--head", "oxcommander/delivery-20261011-120000", "--base", "release/1.2"]);
    expect(pr.args).toContain("--draft");
  });

  it("[9] gh 不在 / 未登录：如实说破，不退化成别的路径", async () => {
    const { run } = fakeRunner({
      "gh pr create": [{ code: 1, stderr: "gh: not logged in" }],
    });
    const r = await publishDeliveryRemote(base({ mode: "pr", run }));
    expect(r.pushed).toBe(true); // push 已成立的事实不受影响
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("gh pr create 失败");
    expect(r.reason).toContain("未登录");
  });

  it("[10] gh 成功但没解析出地址 = 这一步算没成（PR 地址是它的产出）", async () => {
    const { run } = fakeRunner({
      "gh pr create": [{ code: 0, stdout: "created something, no url\n" }],
    });
    const r = await publishDeliveryRemote(base({ mode: "pr", run }));
    expect(r.pushed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("没解析出 PR 地址");
  });

  it("[11] 轮询 CI：pending 变 fail 就停，failed 名单回流（不自动重修）", async () => {
    const { run, calls } = fakeRunner({
      "gh pr": [
        { code: 0, stdout: "https://github.com/o/r/pull/9\n" },
        { code: 0, stdout: `[{"name":"verify","state":"PENDING"}]` },
        { code: 0, stdout: `[{"name":"verify","state":"FAILURE"},{"name":"site","state":"SUCCESS"}]` },
      ],
    });
    const slept: number[] = [];
    const r = await publishDeliveryRemote(
      base({
        mode: "pr",
        run,
        poll: { intervalMs: 1000, maxPolls: 5 },
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe("https://github.com/o/r/pull/9");
    expect(r.checks?.state).toBe("fail");
    expect(r.checks?.failed).toEqual(["verify"]);
    expect(r.checks?.polls).toBe(2);
    expect(slept).toEqual([1000]);
    expect(calls.filter((c) => c.args[1] === "checks")).toHaveLength(2);
  });

  it("[12] 轮询到上限仍是 pending：如实报 pending，次数如实（不假装绿）", async () => {
    const { run } = fakeRunner({
      "gh pr": [
        { code: 0, stdout: "https://github.com/o/r/pull/9\n" },
        { code: 0, stdout: `[{"name":"a","state":"PENDING"}]` },
        { code: 0, stdout: `[{"name":"a","state":"PENDING"}]` },
        { code: 0, stdout: `[{"name":"a","state":"PENDING"}]` },
      ],
    });
    const r = await publishDeliveryRemote(
      base({
        mode: "pr",
        run,
        poll: { intervalMs: 10, maxPolls: 3 },
        sleep: async () => undefined,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks?.state).toBe("pending");
    expect(r.checks?.polls).toBe(3);
  });

  it("[13] checks 输出不是 JSON：unknown，不崩（这道闸的意义是「CI 说了什么」）", async () => {
    const { run } = fakeRunner({
      "gh pr": [
        { code: 0, stdout: "https://github.com/o/r/pull/9\n" },
        { code: 0, stdout: "no checks reported on the 'x' branch" },
        { code: 0, stdout: "no checks reported on the 'x' branch" },
        { code: 0, stdout: "no checks reported on the 'x' branch" },
      ],
    });
    const r = await publishDeliveryRemote(
      base({ mode: "pr", run, poll: { intervalMs: 10, maxPolls: 3 }, sleep: async () => undefined }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks?.state).toBe("unknown");
  });

  it("[14] 默认不轮询：分发不该默认阻塞到 CI 跑完", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryRemote(base({ mode: "pr", run }));
    expect(r.ok).toBe(true);
    expect(r.checks).toBeUndefined();
    expect(calls.some((c) => c.args[1] === "checks")).toBe(false);
  });
});

describe("git-remote · 参数成形（deliveryRemoteArgs，纯函数）", () => {
  it("[15] mode=off → null（不该分发）；其余档位都成形", () => {
    expect(deliveryRemoteArgs("b/x", { mode: "off" })).toBeNull();
    expect(deliveryRemoteArgs("b/x", { mode: "push" })!.mode).toBe("push");
    expect(deliveryRemoteArgs("b/x", { mode: "pr" })!.mode).toBe("pr");
  });

  it("[16] 字段缺席 = 键缺席（不是塞 undefined）：缺席时默认值由执行器自己给", () => {
    const args = deliveryRemoteArgs("b/x", { mode: "push" })!;
    expect("remote" in args).toBe(false);
    expect("base" in args).toBe(false);
    expect("draft" in args).toBe(false);
    expect("poll" in args).toBe(false);
    expect("timeoutMs" in args).toBe(false);
    // 变异锚点：`!== undefined` → `=== undefined`。换成 === 后缺席字段会被塞一个
    // undefined 键（语义上是"显式给了空"），`in` 断言会红。
    expect(args.branch).toBe("b/x");
  });

  it("[17] 给了就透传；draft=false 与缺席同形（不写 false）", () => {
    const args = deliveryRemoteArgs("b/x", {
      mode: "pr",
      remote: "upstream",
      base: "next",
      draft: true,
      timeoutMs: 5_000,
    })!;
    expect(args.remote).toBe("upstream");
    expect(args.base).toBe("next");
    expect(args.draft).toBe(true);
    expect(args.timeoutMs).toBe(5_000);
    expect(deliveryRemoteArgs("b/x", { mode: "pr", draft: false })!.draft).toBeUndefined();
  });

  it("[18] awaitChecks 缺席 = 不轮询；给了就用（缺省值 30s × 10 次）", () => {
    expect(deliveryRemoteArgs("b/x", { mode: "pr" })!.poll).toBeUndefined();
    expect(deliveryRemoteArgs("b/x", { mode: "pr", awaitChecks: {} })!.poll).toEqual({
      intervalMs: 30_000,
      maxPolls: 10,
    });
    expect(deliveryRemoteArgs("b/x", { mode: "pr", awaitChecks: { intervalMs: 1_000, maxPolls: 3 } })!.poll).toEqual({
      intervalMs: 1_000,
      maxPolls: 3,
    });
    // 只给一半 → 另一半走默认（?? 的 mutant 会把它变成 undefined）
    expect(deliveryRemoteArgs("b/x", { mode: "pr", awaitChecks: { maxPolls: 2 } })!.poll).toEqual({
      intervalMs: 30_000,
      maxPolls: 2,
    });
  });
});
