/**
 * 审批门（P2-3）直接单测。
 *
 * 全部确定性、不 spawn 任何进程：纯函数分支用真值表覆盖，壳的 async 行为用
 * 假回调驱动。与 `action-gate.test.ts` 同一风格。
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalGate,
  approvalDeniedReason,
  needsApproval,
} from "../electron/sandbox/approval-gate";

describe("needsApproval（纯函数）", () => {
  it("空清单恒为 false（没配审批 = 零影响）", () => {
    expect(needsApproval([], "npm")).toBe(false);
    expect(needsApproval([], "")).toBe(false);
  });

  it("按 basename 比对：路径形式与扩展名都能命中", () => {
    expect(needsApproval(["deploy"], "deploy")).toBe(true);
    expect(needsApproval(["deploy"], "/usr/local/bin/deploy")).toBe(true);
    expect(needsApproval(["deploy"], "deploy.cmd")).toBe(true);
    expect(needsApproval(["deploy"], "C:\\tools\\deploy.exe")).toBe(true);
  });

  it("大小写不敏感（Windows 上路径大小写混写是常态）", () => {
    expect(needsApproval(["Deploy"], "DEPLOY")).toBe(true);
    expect(needsApproval(["deploy"], "DePloy")).toBe(true);
  });

  it("不相关命令为 false（不能误拦）", () => {
    expect(needsApproval(["deploy"], "npm")).toBe(false);
    expect(needsApproval(["deploy"], "deploy-extra")).toBe(false);
  });
});

describe("ApprovalGate · active 与三态", () => {
  it("没配命令时 active 为 false，且 check 恒返回 undefined（门不生效）", async () => {
    const gate = new ApprovalGate({ commands: [] });
    expect(gate.active).toBe(false);
    expect(await gate.check("anything", [])).toBeUndefined();
  });

  it("配了命令但不在清单里的，返回 undefined（本门无意见，交回静态策略）", async () => {
    const gate = new ApprovalGate({ commands: ["deploy"] });
    expect(await gate.check("npm", ["run", "build"])).toBeUndefined();
  });

  it("在清单里且宿主批准 ⇒ 返回 undefined（放行，但不留痕成 allow）", async () => {
    const gate = new ApprovalGate({ commands: ["deploy"], request: async () => true });
    expect(await gate.check("deploy", ["prod"])).toBeUndefined();
  });

  it("在清单里且宿主拒绝 ⇒ 返回拒绝裁决", async () => {
    const gate = new ApprovalGate({ commands: ["deploy"], request: async () => false });
    const v = await gate.check("deploy", ["prod"]);
    expect(v?.ok).toBe(false);
    expect(v && !v.ok ? v.reason : "").toContain("人工拒绝");
  });
});

describe("ApprovalGate · fail-closed（问不到人就不执行）", () => {
  it("没有回调 ⇒ 拒绝（不假装问过了）", async () => {
    const events: string[] = [];
    const gate = new ApprovalGate({ commands: ["deploy"], onEvent: (t) => events.push(t) });
    const v = await gate.check("deploy", ["prod"]);
    expect(v?.ok).toBe(false);
    expect(events.join("|")).toContain("无审批回调");
  });

  it("回调抛错 ⇒ 拒绝（不把异常当默许）", async () => {
    const gate = new ApprovalGate({
      commands: ["deploy"],
      request: async () => {
        throw new Error("宿主崩了");
      },
    });
    const v = await gate.check("deploy", []);
    expect(v?.ok).toBe(false);
    expect(v && !v.ok ? v.reason : "").toContain("审批回调失败");
  });

  it("拒绝原因说明「怎么办」，而不是只说被拒（那是沙箱地板的说法）", () => {
    const r = approvalDeniedReason("deploy");
    expect(r).toContain("无审批回调");
    // 必须给出两条出路，否则人会去查白名单（查不到东西）
    expect(r).toContain("approvalCommands");
    expect(r).toContain("denyCommands");
  });
});

describe("ApprovalGate · 批次内不再重复问", () => {
  it("批准过的命令第二次直接放行，且不再调用回调", async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      commands: ["deploy"],
      request: async () => {
        calls += 1;
        return true;
      },
    });
    expect(await gate.check("deploy", ["a"])).toBeUndefined();
    expect(await gate.check("deploy", ["b"])).toBeUndefined();
    expect(calls).toBe(1); // 只问了一次
  });

  it("reset 之后重新问（批次边界 = 新的上下文）", async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      commands: ["deploy"],
      request: async () => {
        calls += 1;
        return true;
      },
    });
    await gate.check("deploy", []);
    gate.reset();
    await gate.check("deploy", []);
    expect(calls).toBe(2);
  });

  it("被拒绝的命令不进已批准集合（下一批仍要问）", async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      commands: ["deploy"],
      request: async () => {
        calls += 1;
        return false;
      },
    });
    await gate.check("deploy", []);
    await gate.check("deploy", []);
    expect(calls).toBe(2); // 拒绝不缓存
  });

  it("批准的缓存按 basename，不受路径写法影响", async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      commands: ["deploy"],
      request: async () => {
        calls += 1;
        return true;
      },
    });
    await gate.check("deploy", []);
    await gate.check("/usr/bin/deploy.cmd", []); // 同一命令的另一种写法
    expect(calls).toBe(1);
  });
});

describe("ApprovalGate · 可观测性", () => {
  it("批准与拒绝都进事件流（谁在什么时候问了）", async () => {
    const events: string[] = [];
    const ok = new ApprovalGate({ commands: ["deploy"], request: async () => true, onEvent: (t) => events.push(t) });
    await ok.check("deploy", ["prod"]);
    expect(events.join("|")).toContain("已批准");

    const no = new ApprovalGate({ commands: ["deploy"], request: async () => false, onEvent: (t) => events.push(t) });
    await no.check("deploy", ["prod"]);
    expect(events.join("|")).toContain("人工拒绝");
  });

  it("门不生效时不产生任何事件（默认路径不该留痕）", async () => {
    const events: string[] = [];
    const gate = new ApprovalGate({ commands: [], onEvent: (t) => events.push(t) });
    await gate.check("deploy", []);
    expect(events).toEqual([]);
  });

  it("snapshot 给出清单与已批准项，顺序稳定", async () => {
    const gate = new ApprovalGate({ commands: ["deploy", "migrate"], request: async () => true });
    await gate.check("migrate", []);
    const s = gate.snapshot();
    expect(s.commands).toEqual(["deploy", "migrate"]);
    expect(s.approved).toEqual(["migrate"]);
  });
});
