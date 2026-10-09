/**
 * 桌面侧的交付凭据复核（欠账 #7）。
 *
 * 与 `headless/receipt-verify-main.ts`（命令行，退出码即 CI 判定）是**同一个判据
 * 的两个入口**：五档裁决、指纹比对、复跑比对**都不在这里重写一遍**，一律调
 * `shared/delivery-receipt`。判据分叉是最难被发现的漂移 —— 两份实现各自都
 * "看起来对"，而没有任何测试会红（它们只被各自的调用方观察）。
 *
 * 默认**不执行任何东西**：只算指纹 + 列出可复跑命令，与 CLI 默认模式的
 * exit 5 同义 —— **没复跑就不等于结论为真**。要真的跑必须显式 `replay: true`。
 *
 * 复跑走的门与生产验证是同一道：`platform.verifyCommands` 内部仍是
 * CommandPolicy（沙箱白名单）+ ActionGate + ApprovalGate + 超时。这里刻意
 * 不自己再装一遍 —— 两个入口跑的是同一批脚本，"这条命令要不要先问人"
 * 不该随入口而变。
 */
import { ipcMain } from "electron";
import { createHash } from "node:crypto";
import { stripBom } from "../atomic-file";
import {
  auditReceipt,
  compareChecks,
  replayableCommands,
  verifyReceiptFingerprint,
  type CheckComparison,
  type CheckObservation,
  type DeliveryReceipt,
  type ReceiptAudit,
} from "../../shared/delivery-receipt";
import type { VerificationKind } from "../../shared/types";
import { buildPlatformLayer, logLine, settingsStore, stores, workspaceRoot } from "./context";

export interface ReceiptVerifyResult {
  audit: ReceiptAudit;
  /** 凭据里带命令、因此可被独立复跑的那些命令（默认模式也要给：界面要摆出来）。 */
  commands: Array<{ kind: VerificationKind; command: string; args: string[] }>;
  /** 本次是否真的执行了命令。false = 只查了完整性。 */
  replayed: boolean;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function registerReceiptHandlers(): void {
  ipcMain.handle(
    "receipt:verify",
    async (_e, projectId: string, opts?: { replay?: boolean }): Promise<ReceiptVerifyResult> => {
      const rec = stores().get(projectId);
      if (!rec) throw new Error(`project ${projectId} not found`);
      if (!rec.receiptJson) throw new Error("这个项目还没有交付凭据（跑完一次才会有）");

      // 与命令行同一条纪律：坏掉的凭据该被**如实报成坏**，而不是静默当"没凭据"。
      let receipt: DeliveryReceipt;
      try {
        // 必须剥 BOM：凭据是给人转递的文件，记事本/PowerShell 存过就有 BOM
        // （与 electron/atomic-file.ts 同一道纪律）。
        receipt = JSON.parse(stripBom(rec.receiptJson)) as DeliveryReceipt;
      } catch (err) {
        throw new Error(`凭据读不出来：${(err as Error).message}`);
      }

      const fingerprint = verifyReceiptFingerprint(receipt, sha256);
      const commands = replayableCommands(receipt);

      // 只在指纹一致时才复跑，三档各自有理由（比 CLI 的 `!== "mismatch"` 更严一格，
      // 差在 `unsigned`）：
      //   · mismatch —— 比的是被改过的凭据，比出来的"矛盾"是伪证的产物；
      //   · unsigned —— 没盖章时 `auditReceipt` 会整档早退、把比对结果丢掉，
      //     此刻跑命令纯属白跑副作用（CLI 命令行那侧跑一下无所谓，桌面这侧不然）；
      //   · 没有可复跑命令 —— 那是"这份凭据不经过命令"，不是"能跑但不想跑"。
      const canReplay =
        opts?.replay === true && fingerprint.reason === "match" && commands.length > 0;

      let comparisons: CheckComparison[] = [];
      if (canReplay) {
        const platform = buildPlatformLayer(settingsStore().load(), { log: logLine });
        const report = await platform.verifyCommands(commands, workspaceRoot(projectId));
        const observations: CheckObservation[] = report.results.map((r) => ({
          kind: r.kind,
          ok: r.ok,
          exitCode: r.exitCode,
        }));
        comparisons = compareChecks(receipt.checks, observations);
      }

      return { audit: auditReceipt(receipt, fingerprint, comparisons), commands, replayed: canReplay };
    },
  );
}
