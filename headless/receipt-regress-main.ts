/**
 * 凭据库的**回放门**：把一叠历史凭据当成一份回归清单跑。
 *
 *   1. 每份凭据被改过吗？     → 复算指纹（与 `receipt:verify` 同一个 `verifyReceiptFingerprint`）
 *   2. 凭据说的结论是真的吗？ → `--replay` 时在**本地环境**重跑凭据里记下的命令并比对
 *
 * 用法：
 *   node dist-headless/headless/receipt-regress-main.js [--dir=.ox/receipts] [--limit=10]
 *       默认只审计指纹 + 列出可复跑命令（**不执行任何东西**）
 *   node dist-headless/headless/receipt-regress-main.js --replay --cwd=<目录> [--dir=…]
 *       额外逐份复跑并比对
 *
 * 退出码 —— 与 `receipt:verify` **同一张表**（`shared/receipt-lib` 的 `verdictExitCode`）：
 *   0 = verified  整批的每一份都指纹一致且复跑复现（唯一可以采信的一档）
 *   2 = contradicted  至少一份的结论被复跑推翻
 *   3 = tampered      至少一份被改过
 *   4 = unsigned      至少一份没盖章
 *   5 = not-replayed  没复跑（默认模式），或整批都停在这一档
 *   1 = 用不了（目录不存在 / 里面没有可解析的凭据 / 读不动）
 *
 * ⚠️ 整批取**最严重**的那一档（`worstVerdict`）：一批里只要有一份被推翻，
 * 这一批就不能算过 —— "平均下来还行"在证据上是句废话。
 *
 * ⚠️ `--replay` 会执行凭据文件里记下的命令 —— **只对你自己信任的凭据用**（与单份工具同一条纪律：
 * 沙箱那道地板是防"智能体写坏脚本"的，不是防"有人递给你一份恶意凭据"的）。
 *
 * ⚠️ 成本：每份凭据都会重跑它记下的**全套验证命令**（常常就是一条 `npm test`）。
 * 库大了用 `--limit` 只跑最近 N 份 —— 这是刻意的：默认全跑会把 CI 拖到不可用，
 * 而"跑哪几份"是使用者的判断，不该由工具偷偷替你做。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stripBom } from "../electron/atomic-file";
import {
  auditReceipt,
  compareChecks,
  replayableCommands,
  verifyReceiptFingerprint,
  type CheckObservation,
  type DeliveryReceipt,
  type ReceiptAudit,
  type ReceiptVerdict,
} from "../shared/delivery-receipt";
import { RECEIPTS_DIR, selectReceiptFiles, verdictExitCode, worstVerdict } from "../shared/receipt-lib";
import { verifyProject } from "../electron/engine/verifier";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

interface CaseResult {
  file: string;
  verdict: ReceiptVerdict | "unreadable";
  audit?: ReceiptAudit;
  reason?: string;
}

/** 读一份凭据。读不动**不抛**：一份坏凭据该被如实报成坏，而不是让整批跑不下去。 */
function loadReceipt(file: string): { receipt: DeliveryReceipt } | { error: string } {
  try {
    // 必须剥 BOM：凭据是给人转递的文件（记事本 / PowerShell 存过就有 BOM），
    // 与 `receipt-verify-main` / `electron/ipc/receipt.ts` 同一道纪律。
    return { receipt: JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as DeliveryReceipt };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function auditOne(
  file: string,
  replay: boolean,
  cwd: string,
  log: (t: string) => void,
): Promise<CaseResult> {
  const loaded = loadReceipt(file);
  if ("error" in loaded) return { file, verdict: "unreadable", reason: loaded.error };
  const receipt = loaded.receipt;

  const fingerprint = verifyReceiptFingerprint(receipt, sha256);
  const cmds = replayableCommands(receipt);
  let comparisons;
  // 指纹不符时不复跑：比的是假凭据，比出来的"矛盾"是伪证的产物（与单份工具同一条纪律）。
  if (replay && fingerprint.reason !== "mismatch") {
    const report = await verifyProject(
      cmds.map((c) => ({ kind: c.kind, command: c.command, args: c.args })),
      { cwd: () => cwd, onEvent: log },
    );
    const observations: CheckObservation[] = report.results.map((r) => ({
      kind: r.kind,
      ok: r.ok,
      exitCode: r.exitCode,
    }));
    comparisons = compareChecks(receipt.checks, observations);
  }
  const audit = auditReceipt(receipt, fingerprint, comparisons ?? []);
  return { file, verdict: audit.verdict, audit };
}

async function main(argv: string[]): Promise<number> {
  const replay = argv.includes("--replay");
  const dir = path.resolve(argValue(argv, "--dir") ?? RECEIPTS_DIR);
  const cwd = path.resolve(argValue(argv, "--cwd") ?? process.cwd());
  const limitRaw = argValue(argv, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    process.stderr.write(`--limit=${limitRaw} 非法（要非负整数）\n`);
    return 1;
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`凭据库目录不存在：${dir}\n（约定是项目根的 ${RECEIPTS_DIR}）\n`);
    return 1;
  }

  const { files, skipped } = selectReceiptFiles(fs.readdirSync(dir), { ...(limit !== undefined ? { limit } : {}) });
  if (skipped.length > 0) {
    process.stdout.write(`跳过 ${skipped.length} 个不认得的文件名：${skipped.join("、")}\n`);
  }
  if (files.length === 0) {
    process.stderr.write(`目录里没有可解析的凭据：${dir}\n`);
    return 1;
  }

  const log = (t: string): void => {
    process.stderr.write(`${t}\n`);
  };
  const results: CaseResult[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const r = await auditOne(file, replay, cwd, log);
    results.push(r);
    const verdict = r.verdict === "unreadable" ? "读不动" : r.verdict;
    process.stdout.write(`  ${name}  ${verdict}${r.reason ? `（${r.reason}）` : ""}\n`);
  }

  const verdicts = results.map((r) => r.verdict).filter((v): v is ReceiptVerdict => v !== "unreadable");
  // 读不动的也算整批的账：一份读不出结论的凭据不该被"其余的都好"糊过去。
  const worst = worstVerdict(verdicts);
  const unreadable = results.filter((r) => r.verdict === "unreadable").length;
  // 刻意不打印"这次复跑了没有"：那是 argv 的回声（`--replay` 是调用方自己给的），
  // 摆在这儿只会多一处没人断言的派生量 —— 而没人断言的分支迟早漂。
  process.stdout.write(
    `\n共 ${files.length} 份：readable=${verdicts.length} unreadable=${unreadable}\n` +
      `整批裁决：${worst ?? "（无）"}${worst === undefined ? "" : ` ⇒ exit ${verdictExitCode(worst)}`}\n`,
  );
  if (!replay) {
    process.stdout.write(`要让结论为真，加 --replay --cwd=<项目目录>（会真的执行凭据里记下的命令）\n`);
  }
  if (unreadable > 0) return 1;
  if (worst === undefined) return 1;
  return verdictExitCode(worst);
}

void main(process.argv).then((code) => {
  process.exitCode = code;
});
