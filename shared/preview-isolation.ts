/**
 * 预览窗口的浏览器身份隔离（竞品缺口 C3 的剩余半，2026-10-25）。
 *
 * **缺的是什么**：预览此前一律 `shell.openExternal` 交给系统浏览器，于是
 *   · 所有项目、所有批次共用同一个浏览器 profile —— cookie 的边界是主机名而不是端口，
 *     于是在 `localhost:5173` 上登录过的测试账号，`localhost:8787` 的预览会带着它；
 *   · 应用的预览写进使用者自己的浏览器（历史、cookie、扩展），卸载应用也擦不掉。
 *
 * **为什么必须换成应用内窗口**：隔离要求 profile 由我们指定，外部浏览器给不了这个
 * 控制权（`--user-data-dir` 做不到"每个项目一份"且依赖用户装了什么浏览器）。所以预览
 * 改为应用内窗口 + 按项目派生的 session partition：`persist:` 前缀 = **关窗不丢 cookie**，
 * 同一项目下次预览仍然登录着（这就是竞品那档"命名 profile 复用"）；要"临时 profile"
 * 语义的使用者点界面上的清除动作，清理由显式动作负责，不偷偷发生。
 *
 * **本文件只放纯判定**（双端可测、零 electron 依赖）：项目 id → partition 名。窗口本身、
 * 导航守卫、存储清理在 `electron/preview-window.ts`。
 *
 * **判据形状：白名单字符集 + 长度上限，畸形身份一律拒绝。**
 * · 为什么不哈希：partition 名就是磁盘上的目录名（`userData/Partitions/<name>`），
 *   白名单拼出来的名字可读、可对照 —— 哪个目录属于哪个项目一眼看得出；哈希把它变成
 *   一串十六进制，隔离出问题时排查代价反而更高。白名单同时挡住了 `..`、`/`、`:` 这类
 *   会被当成路径分隔符的字符，长度上限挡住超长 id 撑爆目录名。
 * · 为什么不"退化成共享 profile"：身份缺失时给一个公共 partition，等于把隔离降级成假象，
 *   而使用者以为自己看的是隔离环境 —— 那比不隔离更糟。拒绝，是这里唯一诚实的选择。
 */
const PREVIEW_PARTITION_PREFIX = "persist:ox-preview-";
/** 项目 id 的长度上限：store 铸造的是 `p-<毫秒>-<序号>`，这里是兜底而不是规格。 */
const MAX_PROJECT_ID_CHARS = 64;
/** 允许的字符集：字母、数字、`-`、`_`。目录名安全，且覆盖本仓库 id 的实际形态。 */
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 项目 id → 该项目的预览 profile 名；拿不到隔离身份时返回 `undefined`。
 *
 * 同一个项目 id 必须永远映射到同一个 partition（否则"登录一次、之后都登录着"不成立），
 * 不同项目必须映射到不同 partition（否则隔离是假的）—— 白名单直拼同时满足这两条，
 * 因为它既确定又单射。
 */
export function previewPartitionOf(projectId: unknown): string | undefined {
  if (typeof projectId !== "string") return undefined;
  if (projectId.length > MAX_PROJECT_ID_CHARS) return undefined;
  if (!SAFE_PROJECT_ID.test(projectId)) return undefined;
  return `${PREVIEW_PARTITION_PREFIX}${projectId}`;
}
