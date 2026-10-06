/**
 * 门禁：preload 暴露给渲染进程的 IPC 通道，必须与 `ipcMain.handle` 注册的**完全一致**。
 *
 * 为什么需要它（2026-10-05 全方面体检）：`electron/preload.ts` 的函数覆盖是 **0%**
 * —— 它被 import 但那些转发函数从没被调用过。没有测试守着它，而它是
 * **渲染进程与主进程之间唯一的 API 表面**：通道名写错的后果是渲染端
 * `ipcRenderer.invoke()` 永远 reject，而这种错误只在**真跑桌面端**时才看得见。
 *
 * 为什么不写 31 个转发函数的单元测试（更贵的做法）：
 * 真正会咬人的不是"某个转发函数今天写错了"（那会立刻在手动跑里炸出来），
 * 而是「**主进程新增了一个 handler，却忘了在 preload 暴露**」——
 * 功能静默缺失，没有报错，没有日志。所以判据是**两个集合的关系**，
 * 不是每个函数的实现。
 *
 * 判定（两个方向都要查，缺一不可）：
 *   1. preload 引用了但没人 handle → 渲染端一调就 reject，且只在运行时炸
 *   2. 主进程 handle 了但 preload 没暴露 → 功能**静默不可用**（更难发现：
 *      连报错都没有，UI 上只是"按钮点了没反应"）
 * 外加：同一通道被 invoke 两次（复制粘贴错误，会掩盖第 1 条）。
 *
 * ⚠️ 读不到任何一侧时必须 FAIL，不能当作"一致"放过 —— 解析失败当通过，
 * 就是一道永远绿的摆设（与 check-tests-collected.mjs 同一纪律）。
 *
 * 用法：node scripts/check-ipc-channels.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = path.join(ROOT, "electron", "preload.ts");
const IPC_DIR = path.join(ROOT, "electron", "ipc");

/** preload 里的 `ipcRenderer.on(...)` 监听通道 —— 它们**不该**有 handler。 */
const LISTEN_CHANNELS = new Set(["ox:event"]);

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

// ---- 读 preload：invoke 的通道 + 重复调用 ------------------------------------
const preloadText = fs.readFileSync(PRELOAD, "utf8");
if (!/ipcRenderer\.invoke/.test(preloadText)) {
  fail("electron/preload.ts 里一个 ipcRenderer.invoke 都没有 —— 解析失配，判据本身坏了");
}
const invoked = new Map(); // channel -> 出现次数
for (const m of preloadText.matchAll(/ipcRenderer\.invoke\(\s*["'`]([\w:.-]+)["'`]/g)) {
  invoked.set(m[1], (invoked.get(m[1]) ?? 0) + 1);
}
if (invoked.size === 0) {
  fail("没从 preload 里解析出任何 invoke 通道 —— 判据失配（改过写法？）");
}

// ---- 读主进程：handle 的通道 ------------------------------------------------
const handled = new Map(); // channel -> 注册文件
const ipcFiles = fs.readdirSync(IPC_DIR).filter((n) => n.endsWith(".ts"));
if (ipcFiles.length === 0) fail(`electron/ipc 下没有任何 .ts —— 判据失配（路径变了？）`);
for (const f of ipcFiles) {
  const text = fs.readFileSync(path.join(IPC_DIR, f), "utf8");
  for (const m of text.matchAll(/ipcMain\.handle\(\s*["'`]([\w:.-]+)["'`]/g)) {
    if (handled.has(m[1])) {
      fail(`通道 ${m[1]} 被注册了两次（${handled.get(m[1])} 与 electron/ipc/${f}）—— ipcMain.handle 会抛，但注册顺序决定谁生效`);
    }
    handled.set(m[1], `electron/ipc/${f}`);
  }
}
if (handled.size === 0) {
  fail("没从 electron/ipc 下解析出任何 ipcMain.handle —— 判据失配（改过写法？）");
}

// ---- 判定 1：preload 引用了但没人 handle ------------------------------------
const dangling = [...invoked.keys()].filter((c) => !handled.has(c));
if (dangling.length > 0) {
  console.error(`\nFAIL: preload 暴露了 ${dangling.length} 个没人注册的通道 —— 渲染端一调就永远 reject：`);
  for (const c of dangling) console.error(`  ${c}`);
  console.error(
    "\n处置：① 若该通道已废弃，删掉 preload 里的转发；\n" +
      "      ② 若主进程该注册，检查是否漏了 ipcMain.handle，或写错了通道名。\n",
  );
  process.exit(1);
}

// ---- 判定 2：主进程 handle 了但 preload 没暴露 -------------------------------
const unexposed = [...handled.keys()].filter((c) => !invoked.has(c) && !LISTEN_CHANNELS.has(c));
if (unexposed.length > 0) {
  console.error(`\nFAIL: 主进程注册了 ${unexposed.length} 个 preload 没暴露的通道 —— 功能**静默不可用**（UI 上只是"点了没反应"）：`);
  for (const c of unexposed) console.error(`  ${c}  （${handled.get(c)}）`);
  console.error(
    "\n处置：① 若确实不该给渲染端用（比如由主进程内部调用），写进本文件的\n" +
      "      NOT_EXPOSED 表并说明理由；\n" +
      "      ② 若应该暴露，在 electron/preload.ts 的 api 里加一条转发。\n",
  );
  process.exit(1);
}

// ---- 判定 3：同一通道 invoke 多次 -------------------------------------------
const dupes = [...invoked].filter(([, n]) => n > 1);
if (dupes.length > 0) {
  console.error(`\nFAIL: ${dupes.length} 个通道被 invoke 多次 —— 复制粘贴错误，会掩盖判定 1：`);
  for (const [c, n] of dupes) console.error(`  ${c} × ${n}`);
  process.exit(1);
}

console.log(
  `PASS: IPC 通道两侧一致 —— preload ${invoked.size} 个 invoke ⇔ ipcMain.handle ${handled.size} 个注册，无悬空、无未暴露、无重复`,
);