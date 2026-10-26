import { describe, expect, it } from "vitest";
import {
  COMMIT_RE,
  DELIVERY_STATUS_CONTEXT,
  STATUS_DESCRIPTION_MAX,
  deliveryStatusFor,
  publishDeliveryStatus,
} from "../electron/engine/git-status";

/**
 * 这一组守的是**"凭据能不能被别人要求"**这件事的判据本身（第七轮竞品吸收 3）。
 *
 * 最坏的失败方式不是"发不出去"，而是**发出一条不该绿的绿**：分支保护一旦把它当门槛，
 * 一次误判就等于把闸门交给了自述。所以每条用例都对着"什么情况下**不许** success"写。
 */

const FP = "a".repeat(64);

function receipt(over: Partial<Parameters<typeof deliveryStatusFor>[0]> = {}) {
  return { outcome: "delivered" as const, fingerprint: FP, headline: "已交付", ...over };
}

function fakeRunner(step: { code: number; stdout?: string; stderr?: string } = { code: 0 }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    return { code: step.code, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { run, calls };
}

describe("deliveryStatusFor · 什么情况下才敢给 success", () => {
  it("delivered + 指纹一致 ⇒ success，description 带指纹前 12 位（读的人能据此找到那份凭据）", () => {
    const d = deliveryStatusFor(receipt(), true);
    expect(d.state).toBe("success");
    expect(d.context).toBe(DELIVERY_STATUS_CONTEXT);
    expect(d.description).toContain(FP.slice(0, 12));
  });

  it("blocked + 指纹一致 ⇒ failure（结论是真的，只是没交付）", () => {
    const d = deliveryStatusFor(receipt({ outcome: "blocked" }), true);
    expect(d.state).toBe("failure");
  });

  it("没指纹 ⇒ error，绝不给 success（没盖章就无从判断完整性）", () => {
    const d = deliveryStatusFor(receipt({ fingerprint: undefined }), true);
    expect(d.state).toBe("error");
    expect(d.description).toContain("unsigned");
  });

  it("指纹不符 ⇒ error，连 delivered 也不采信（与 receipt:verify 的 tampered 同一档）", () => {
    const d = deliveryStatusFor(receipt({ outcome: "delivered" }), false);
    expect(d.state).toBe("error");
    expect(d.description).toContain("指纹不符");
  });

  it("没指纹、指纹复算也不通过时报 unsigned 而不是 mismatch（先说明更根本的那条）", () => {
    // 顺序是承重的：指纹都没贴，却报"不符"会把人引去查一个不存在的篡改。
    const d = deliveryStatusFor(receipt({ fingerprint: undefined }), false);
    expect(d.state).toBe("error");
    expect(d.description).toContain("unsigned");
  });

  it("blocked 的 headline 进 description；没有 headline 时不留一个空冒号", () => {
    expect(deliveryStatusFor(receipt({ outcome: "blocked", headline: "验证未通过" }), true).description).toContain(
      "验证未通过",
    );
    const bare = deliveryStatusFor(receipt({ outcome: "blocked", headline: "" }), true);
    expect(bare.description).not.toContain("：");
  });

  it("description 收在一行且不超过 GitHub 的上限（换行会被 GitHub 截断，长文会被拒）", () => {
    const d = deliveryStatusFor(receipt({ outcome: "blocked", headline: "x\n".repeat(400) }), true);
    expect(d.description.length).toBeLessThanOrEqual(STATUS_DESCRIPTION_MAX);
    expect(d.description).not.toContain("\n");
  });
});

describe("publishDeliveryStatus · 发送面（永不 throw、永不折成 success）", () => {
  it("用 gh api 往 {owner}/{repo}/statuses/<sha> 发一条，四个字段都在", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryStatus({
      projectRoot: "D:/p",
      commit: "abc1234",
      decision: deliveryStatusFor(receipt(), true),
      run,
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe("success");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("gh");
    expect(call!.args).toContain("POST");
    expect(call!.args).toContain("repos/{owner}/{repo}/statuses/abc1234");
    expect(call!.args).toContain("state=success");
    expect(call!.args).toContain(`context=${DELIVERY_STATUS_CONTEXT}`);
    expect(call!.args.some((a) => a.startsWith("description="))).toBe(true);
  });

  it("给了 targetUrl 才带 target_url（没给就不发一个空串上去）", async () => {
    const withUrl = fakeRunner();
    await publishDeliveryStatus({
      projectRoot: "D:/p",
      commit: "abc1234",
      decision: deliveryStatusFor(receipt(), true),
      targetUrl: "https://example.com/r",
      run: withUrl.run,
    });
    expect(withUrl.calls[0]!.args).toContain("target_url=https://example.com/r");

    const noUrl = fakeRunner();
    await publishDeliveryStatus({
      projectRoot: "D:/p",
      commit: "abc1234",
      decision: deliveryStatusFor(receipt(), true),
      run: noUrl.run,
    });
    expect(noUrl.calls[0]!.args.some((a) => a.startsWith("target_url="))).toBe(false);
  });

  it("commit 不像 sha ⇒ 跳过（连 gh 都不跑）：拿一个分支名去发 status 只会得到 404", async () => {
    const { run, calls } = fakeRunner();
    const r = await publishDeliveryStatus({
      projectRoot: "D:/p",
      commit: "oxcommander/delivery-x",
      decision: deliveryStatusFor(receipt(), true),
      run,
    });
    expect(r.skipped).toBe("bad-commit");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("gh 失败 ⇒ ok=false 且带原因，**状态不是 success**（网络失败绝不重试成绿）", async () => {
    const { run } = fakeRunner({ code: 1, stderr: "gh: not logged in" });
    const r = await publishDeliveryStatus({
      projectRoot: "D:/p",
      commit: "abc1234",
      decision: deliveryStatusFor(receipt(), true),
      run,
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBeUndefined();
    expect(r.reason).toContain("not logged in");
  });

  it("COMMIT_RE 只认十六进制短 sha 到 40 位", () => {
    for (const good of ["abc1234", "A".repeat(40), "0123456789abcdef0123456789abcdef01234567"]) {
      expect(COMMIT_RE.test(good), good).toBe(true);
    }
    for (const bad of ["abc123", "", "xyz1234", "main", "abc1234\n"]) {
      expect(COMMIT_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
