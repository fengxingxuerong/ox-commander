/**
 * B2 对照实验 · 机器汇总（实验用，不进产品链路，不进门禁）。
 *
 * 为什么存在：`docs/2026-10-18-zone-vs-worktree-b2.md` 的数字必须能从产物直接
 * 再算一遍，而不是从报告里手抄。三份产物：
 *   - zone 侧：e2e 日志里的最终 receipt（每任务时长/尝试/执行器 + usage）
 *   - zone 侧：run journal（snapshot.batches —— 批序列与批宽）
 *   - worktree 侧：b2-worktree-run.mjs 的 metrics JSON（创建/生成/合并/终验/墙钟）
 * 另可加 --t6-attempts 列 t6 重修各轮的机器读数（b2-t6-*-result.json）。
 *
 * 口径警告（报告限制节同款）：两侧执行器不同、跑的时代不同（池/天气），
 * 本脚本只汇总事实，不做任何换算——**报告不下"快 X%"结论，脚本也不引入**。
 *
 * 用法：
 *   node scripts/b2-zone-vs-worktree-report.mjs \
 *     --zone-log=<e2e 日志> --journal=<journal.json> \
 *     --worktree-metrics=<metrics.json> [--t6-attempts=<a.json,b.json,...>]
 */
import fs from "node:fs";

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const zoneLogPath = arg("zone-log");
const journalPath = arg("journal");
const metricsPath = arg("worktree-metrics");
const t6AttemptsDir = arg("t6-attempts-dir");

if (!zoneLogPath || !journalPath || !metricsPath) {
  console.error(
    "用法：node scripts/b2-zone-vs-worktree-report.mjs " +
      "--zone-log=<e2e 日志> --journal=<journal.json> --worktree-metrics=<metrics.json> " +
      "[--t6-attempts-dir=<目录，自动收集 b2-t6-*-result.json>]",
  );
  process.exit(2);
}

function readJson(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`缺产物（${what}）：${p}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const sec = () => (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : String(ms));
const s = sec();

// ---- zone 侧：receipt ----
const logLines = fs.readFileSync(zoneLogPath, "utf8").split(/\r?\n/);
const receiptLine = logLines.filter((l) => l.includes('"type":"receipt"')).pop();
if (!receiptLine) {
  console.error(`日志里没有 receipt 行：${zoneLogPath}`);
  process.exit(2);
}
const receipt = JSON.parse(receiptLine.slice(receiptLine.indexOf("{"))).receipt;

// ---- zone 侧：journal 批次 ----
const journal = readJson(journalPath, "run journal");
const batches = (journal.snapshot && journal.snapshot.batches) || null;
if (!batches) {
  console.error(`journal 里没有 snapshot.batches：${journalPath}`);
  process.exit(2);
}
const batchIds = batches.map((b) => b.map((t) => t.id));
const attempts = (journal.snapshot && journal.snapshot.attempts) || {};

// ---- worktree 侧 ----
const m = readJson(metricsPath, "worktree metrics");
const order = m.taskOrder || Object.keys(m.agents || {});

const out = [];
out.push("B2 对照（zone 互斥 vs worktree 隔离）—— 机器汇总");
out.push(`zone 日志：${zoneLogPath}`);
out.push(`journal：${journalPath}`);
out.push(`worktree metrics：${metricsPath}`);
out.push("");

// zone 表
out.push("[zone 侧] 产品链路真跑（receipt）");
out.push("任务 | zone | 尝试 | 时长 | 执行器");
for (const t of receipt.tasks) {
  out.push(`${t.id} | ${t.zone} | ${t.attempts} | ${s(t.durationMs)} | ${t.agentId}`);
}
const zoneSum = receipt.tasks.reduce((a, t) => a + (t.durationMs || 0), 0);
out.push(`任务时长合计：${s(zoneSum)}（批次串行，墙钟 ≥ 此值；两端点见日志文件名与收据时间戳）`);
out.push(
  `批序列：${batchIds.map((b) => `[${b.join(",")}]`).join(" ")} ` +
    `（批数 ${batchIds.length}，批宽 ${batchIds.map((b) => b.length).join("/")}）`,
);
const depsOnly = batchIds.every((b, i) => i === 0 || b.every((id) => {
  const task = batches[i].find((t) => t.id === id);
  return (task.dependencies || []).length > 0;
}));
out.push(`批内任务全部带依赖（依赖驱动；zone 冲突切刀未见）: ${depsOnly ? "是" : "否"}`);
out.push(
  `收据：conflicts=${receipt.counts.conflicts}，done=${receipt.counts.done}/${receipt.counts.total}，` +
    `rounds=${receipt.rounds}，usage=${receipt.usage.totalTokens} tokens / ${receipt.usage.calls} calls`,
);
out.push("");

// worktree 表
out.push("[worktree 侧] worktrunk + 单发执行器（metrics）");
out.push("任务 | 首跑生成 | 备注");
for (const id of order) {
  const a = (m.agents || {})[id];
  if (!a) {
    out.push(`${id} | — | 无记录`);
    continue;
  }
  const note = a.ok ? `files=${(a.files || []).join(",")}` : `失败：${a.error || "unknown"}`;
  out.push(`${id} | ${a.ok ? s(a.genMs) : `—（${s(a.wallMs)} 后失败）`} | ${note}`);
}
const creates = Object.values(m.worktrees || {});
if (creates.length) {
  const sum = creates.reduce((a, w) => a + (w.createMs || 0), 0);
  out.push(
    `worktree 创建：${creates.length} ×（合计 ${s(sum)}，均 ${s(sum / creates.length)}，` +
      `磁盘各 ${creates[0].diskBytes} B）`,
  );
}
const merges = Object.entries(m.merges || {});
const merged = merges.filter(([, v]) => v.ok);
if (merged.length) {
  const sum = merged.reduce((a, [, v]) => a + v.ms, 0);
  out.push(
    `合并：${merged.length} ×（合计 ${s(sum)}，均 ${s(sum / merged.length)}，` +
      `冲突 ${merged.filter(([, v]) => v.conflict).length}，自动清理 ${merged.filter(([, v]) => v.worktreeRemoved).length}/${merged.length}）`,
  );
  for (const [id, v] of merges.filter(([, v]) => !v.ok)) out.push(`合并跳过：${id}（${v.reason}）`);
}
const fv = m.finalVerify || {};
out.push(
  `首跑终验：build=${fv.build ? (fv.build.ok ? "✓" : "✗") : "?"} ` +
    `test=${fv.test ? (fv.test.ok ? "✓" : "✗") : "?"} ` +
    `smoke=${fv.smoke ? (fv.smoke.ok ? "✓" : "✗") : "?"}`,
);
out.push(`墙钟：agents ${s(m.agentsWallMs)}，全流程 ${s(m.totalWallMs)}（${m.startedAt} → ${m.finishedAt}）`);

if (t6AttemptsDir) {
  const files = fs
    .readdirSync(t6AttemptsDir)
    .filter((f) => /^b2-t6-.*-result\.json$/.test(f))
    .sort();
  out.push("");
  out.push("[worktree 侧 · t6 重修各轮]（人工逐轮喂 digest，不在 metrics 里）");
  for (const f of files) {
    const a = readJson(`${t6AttemptsDir}/${f}`, "t6 attempt");
    out.push(`${f}：gen ${s(a.genMs)}，commit ${s(a.commitMs)}，files=${(a.files || []).join(",")}`);
  }
}

out.push("");
out.push("口径提醒：两侧执行器不同（zone=产品执行器；worktree=单发 chatJson 无工具）；");
out.push("两侧运行时代不同（模型池换血 + 供应商配额天气）；本汇总不做换算、不结论。");
out.push(
  `journal attempts 记录：${Object.entries(attempts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
);

console.log(out.join("\n"));
