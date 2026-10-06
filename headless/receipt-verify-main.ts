/**
 * 交付凭据的**独立复核工具**：拿到一份 receipt JSON，回答两个不同的问题。
 *
 *   1. 这份凭据被改过吗？   → 重算指纹比对（`canonicalReceiptPayload` 的可复现性）
 *   2. 凭据说的结论是真的吗？ → 在**本地环境**重跑凭据里记下的命令，比对结论
 *
 * 这两个问题是**分开的**，工具也分开回答（`auditReceipt` 的 verdict 五档）。
 * 指纹一致**不等于**结论为真 —— 把两者混为一谈，复核工具就成了给自述背书的
 * 橡皮图章。这正是本工具存在的理由：让"这份交付过了门禁"从一句自述，
 * 变成任何持有凭据的人都能自己复现的观察。
 *
 * 用法：
 *   node dist-headless/headless/receipt-verify-main.js <receipt.json>
 *       只校验指纹 + 打印可复跑的命令清单（默认，**不执行任何东西**）
 *   node dist-headless/headless/receipt-verify-main.js <receipt.json> --replay --cwd=<dir>
 *       额外在 <dir> 里重跑凭据记录的命令并比对（会真的执行命令，见下）
 *
 * ⚠️ `--replay` 会执行凭据文件里记下的命令 —— **只对你自己信任的凭据用**。
 * 命令走与生产验证同一套 `CommandPolicy` 沙箱（破坏性程序、shell 元字符照样拒绝），
 * 但那道地板是用来防"智能体写坏脚本"的，不是用来防"有人递给你一份恶意凭据"的。
 * 所以默认不执行；要执行必须显式给 `--replay`。
 *
 * 退出码 —— 每一档对应一个**不同的处置**，刻意不并档：
 *   0 = verified         指纹一致且复跑全部复现（唯一可以采信的一档）
 *   2 = contradicted     指纹一致但复跑与凭据矛盾 → 去查差异来源
 *   3 = tampered         指纹不符 → 凭据被改过，结论一律不采信
 *   4 = unsigned         没有指纹 → 无从判断完整性，先补盖章
 *   5 = not-replayed     指纹一致但一条都没复跑 → 加 --replay 才能得到结论
 *   1 = 用不了（没给文件 / 读不到 / 解析不了）
 *
 * 为什么 `not-replayed` 不从 0：默认模式只查完整性，**不等于**结论为真。
 * 若把"没复跑"报成 0，任何只看退出码的下游流水线都会把它读成"已核"——
 * 那就成了给自述背书的橡皮图章（本工具存在的反面）。
 * 「跑不动」（unrunnable）单条不构成失败，也不单独占退出码：它只说明这条复核不了。
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { stripBom } from "../electron/atomic-file";
import {
  auditReceipt,
  compareChecks,
  replayableCommands,
  verifyReceiptFingerprint,
  type CheckObservation,
  type DeliveryReceipt,
} from "../shared/delivery-receipt";
import { verifyProject } from "../electron/engine/verifier";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

/** 非 --flag 形式的位置参数。 */
function positional(argv: string[]): string[] {
  return argv.slice(2).filter((a) => !a.startsWith("--"));
}

async function main(argv: string[]): Promise<number> {
  const files = positional(argv);
  if (files.length === 0) {
    process.stderr.write(
      "用法：receipt-verify-main.js <receipt.json> [--replay] [--cwd=<dir>]\n" +
        "  默认只校验指纹并列命令；--replay 才会真的重跑（只对信任的凭据用）。\n",
    );
    return 1;
  }

  let receipt: DeliveryReceipt;
  try {
    // 反序列化后的对象形状由凭据自己决定 —— 校验函数对缺字段是容忍的
    // （缺 command 就是"没有可复跑的命令"，缺 fingerprint 就是"没盖章"），
    // 所以这里不做 schema 校验：一个坏掉的凭据该被**如实报成坏**，而不是崩掉。
    //
    // ⚠️ 必须剥 BOM：`JSON.parse` 不接受 U+FEFF，而凭据是**给人看、给人转递**
    // 的文件 —— 用记事本 / PowerShell `Set-Content -Encoding UTF8` / Excel 打开
    // 再存回，都会给它加一个 BOM。带 BOM 时旧实现直接 exit 1（"读不了凭据"），
    // 于是"谁都能独立复核"这个卖点恰恰在最常见的流转方式下失效（2026-10-05 实测：
    // 同一份凭据，仅差 BOM，退出码 4 → 1）。与 `electron/atomic-file.ts` 的
    // `readJsonFile` 用同一个 `stripBom`，两处读凭据/读配置的 BOM 纪律一致。
    receipt = JSON.parse(stripBom(fs.readFileSync(files[0]!, "utf8"))) as DeliveryReceipt;
  } catch (err) {
    process.stderr.write(`读不了凭据：${(err as Error).message}\n`);
    return 1;
  }

  const fingerprint = verifyReceiptFingerprint(receipt, sha256);
  const cmds = replayableCommands(receipt);
  const replay = argv.includes("--replay");
  const cwd = argValue(argv, "--cwd") ?? process.cwd();

  let comparisons;
  if (replay && fingerprint.reason !== "mismatch") {
    // 指纹不符时不复跑：比的是假凭据，比出来的"矛盾"是伪证的产物（auditReceipt 同一条纪律）。
    const report = await verifyProject(
      cmds.map((c) => ({ kind: c.kind, command: c.command, args: c.args })),
      { cwd: () => cwd, onEvent: (t) => process.stderr.write(`${t}\n`) },
    );
    const observations: CheckObservation[] = report.results.map((r) => ({
      kind: r.kind,
      ok: r.ok,
      exitCode: r.exitCode,
    }));
    comparisons = compareChecks(receipt.checks, observations);
  }

  const audit = auditReceipt(receipt, fingerprint, comparisons ?? []);

  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (!replay) {
    process.stdout.write(`\n可独立复跑的命令（${cmds.length} 条）：\n`);
    for (const c of cmds) process.stdout.write(`  [${c.kind}] ${c.command} ${c.args.join(" ")}\n`);
    if (cmds.length > 0) {
      process.stdout.write(`\n要复跑：加 --replay --cwd=<项目目录>（会真的执行上面的命令）\n`);
    }
  }
  // 五档裁决 → 五个退出码（见文件头的表）。顺序敏感：先判"结论被推翻"，
  // 因为它比"没复跑"更严重，两者同时出现时要报更严重的那档。
  if (audit.verdict === "verified") return 0;
  if (audit.verdict === "contradicted") return 2;
  if (audit.verdict === "tampered") return 3;
  if (audit.verdict === "unsigned") return 4;
  return 5; // not-replayed
}

void main(process.argv).then((code) => {
  process.exitCode = code;
});
