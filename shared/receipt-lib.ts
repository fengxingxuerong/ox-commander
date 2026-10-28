/**
 * 凭据库（2026-10-26，第七轮竞品吸收 · 凭据回放门）。
 *
 * ## 为什么要有它
 *
 * 一次 run 的凭据过去是**一次性**的：桌面每次覆盖项目记录里的 `receiptJson`
 * （`electron/ipc/orchestration.ts`），headless 由宿主自己存一份 `receipt.json`。
 * 于是"上次在这里红过"没有任何实物 —— 想回归只能靠人凭记忆重跑。
 * 这一层把凭据按时间累积成**一叠**，`receipt:regress` 才有东西可跑。
 *
 * ## 这一层只做三件事（纯逻辑，不碰 IO）
 *
 * 1. **命名与解析**：文件名里的两样东西都必须是**真事实** —— 落盘时刻（调用方给的
 *    时间戳）与凭据指纹（凭据自己的前 8 位）。刻意不往里塞派生的东西：塞进去就得
 *    有第二套解码规则，而第二套规则一旦与第一套漂开，读的人会以为文件名在说别的事。
 * 2. **severity 排序**：一批凭据的裁决不一致时，"整批算哪一档"必须有唯一定义。
 * 3. **退出码**：与 `receipt:verify` **同一张表**（单份与一批同义），CI 不必学两套。
 *
 * IO 一律在调用方（CLI / 宿主）：这样判据能被变异门禁逐位点审。
 */
import type { ReceiptVerdict } from "./delivery-receipt";

/** 凭据库的目录约定（相对项目根）。 */
export const RECEIPTS_DIR = ".ox/receipts";

/** 时间戳段的口径与 `git-export.deliveryStamp()` 逐字一致（本地时间 yyyyMMdd-HHmmss）。 */
export const RECEIPT_STAMP_RE = /^\d{8}-\d{6}$/;

/** 凭据文件名：`<stamp>-<指纹前 8 位>.json`。 */
const FILENAME_RE = /^(\d{8}-\d{6})-([0-9a-f]{8})\.json$/;

/**
 * 造一个凭据文件名（纯函数）。
 *
 * 指纹缺席时**不编造**：抛错。凭据库的索引必须真的指向某份凭据，一个随手编的
 * 前缀会让"按文件名找凭据"变成猜谜。
 */
export function receiptFilename(stamp: string, fingerprint: string | undefined): string {
  if (!RECEIPT_STAMP_RE.test(stamp)) {
    throw new Error(`时间戳段不合法：${JSON.stringify(stamp)}（要 yyyyMMdd-HHmmss）`);
  }
  if (fingerprint === undefined || fingerprint.length < 8) {
    throw new Error("凭据没有指纹（或不足 8 位）：凭据库的索引不能凭空造一个");
  }
  return `${stamp}-${fingerprint.slice(0, 8)}.json`;
}

export interface ReceiptFileMeta {
  /** 落盘时刻段（文件名里的事实，不解析成 Date —— 解析要时区，而这里只需要排序用的字符串）。 */
  stamp: string;
  /** 凭据指纹前 8 位。 */
  prefix: string;
}

/** 解析凭据文件名。认不出的返回 `null`（目录里可能有别人的文件）。 */
export function parseReceiptFilename(name: string): ReceiptFileMeta | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  return { stamp: m[1]!, prefix: m[2]! };
}

/**
 * 裁决的**严重度排序**（数字越大越严重）。
 *
 * 为什么需要：一批凭据里各份的裁决可能不同，而"整批算哪一档"必须是**唯一定义** ——
 * 否则同一叠凭据在两次运行里能给出两个结论，那正是不可复现。
 *
 * 排序理由（从重到轻）：
 * - `tampered`：证据本身被改过 —— 最重，因为其余判断都建立在它上面；
 * - `contradicted`：结论与环境矛盾 —— 凭据说的不是真的；
 * - `unsigned`：无从判断完整性 —— 不可采信（"不知道"不等于"没事"）；
 * - `not-replayed`：一份都没复跑 —— 没查；
 * - `verified`：唯一可以采信的那一档。
 */
export const VERDICT_SEVERITY: Record<ReceiptVerdict, number> = {
  verified: 0,
  "not-replayed": 1,
  unsigned: 2,
  contradicted: 3,
  tampered: 4,
};

/** 一批裁决里最严重的那一档。空数组返回 `undefined`（"没有凭据"不是"通过"）。 */
export function worstVerdict(verdicts: readonly ReceiptVerdict[]): ReceiptVerdict | undefined {
  let worst: ReceiptVerdict | undefined;
  for (const v of verdicts) {
    if (worst === undefined || VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) worst = v;
  }
  return worst;
}

/**
 * 裁决 → 退出码。**与 `receipt-verify-main` 同一张表**（那支 CLI 现在也读这里）：
 * 单份与一批同义，CI 只学一套。
 *
 * 刻意不让 `not-replayed` 落到 0：默认模式只查完整性，**不等于**结论为真
 * （理由详 `headless/receipt-verify-main.ts` 文件头）。
 */
export function verdictExitCode(verdict: ReceiptVerdict): number {
  if (verdict === "verified") return 0;
  if (verdict === "contradicted") return 2;
  if (verdict === "tampered") return 3;
  if (verdict === "unsigned") return 4;
  return 5; // not-replayed
}

/** 一批凭据里挑出要跑的那些的选择条件。 */
export interface RegressFilter {
  /**
   * 最多跑几份（按时间倒序取最近 N 份；缺省 = 全部）。
   *
   * 刻意**没有**"按裁决筛"这一格：裁决要读文件、复算指纹甚至复跑之后才知道，
   * 而"挑文件"发生在这一切之前。放一个筛不动的条件在这里，只会让人以为它生效了。
   */
  limit?: number;
}

/**
 * 按时间倒序挑出要跑的凭据文件名。
 *
 * 排序用**文件名里的时间戳段**（字典序即时间序，因为格式是定长零填充）——
 * 不读文件内容、不看 mtime：mtime 会被 checkout / 拷贝改掉，而文件名里的戳是落盘时写死的。
 *
 * 认不出的文件名一律**跳过**（目录里可能有 `.gitkeep` 或别人的文件），
 * 但不静默：调用方拿 `skipped` 说破。
 */
export function selectReceiptFiles(
  names: readonly string[],
  filter: RegressFilter = {},
): { files: string[]; skipped: string[] } {
  const known: Array<{ name: string; stamp: string }> = [];
  const skipped: string[] = [];
  for (const name of names) {
    const meta = parseReceiptFilename(name);
    if (meta === null) {
      skipped.push(name);
      continue;
    }
    known.push({ name, stamp: meta.stamp });
  }
  // 时间倒序：同一秒内的多份按名字再排一次，保证同一叠输入永远给同一个顺序。
  known.sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));
  const picked = filter.limit === undefined ? known : known.slice(0, Math.max(0, filter.limit));
  return { files: picked.map((k) => k.name), skipped };
}
