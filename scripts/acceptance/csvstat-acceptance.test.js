/**
 * 独立验收套件 v2 —— 由平台外验收方（Loomy）编写，与交付方测试相互独立。
 *
 * 语义基线（验收中与交付方对齐确认）：columnStats(rows) 将 rows[0] 视为表头
 * 跳过，total 为数据行数（不含表头）；其余契约条款逐字验收。
 * 覆盖：多行引号字段、空输入、负数/小数、参差行、格式正则、错误路径。
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseCsv } = require("../src/core/csv.js");
const { columnStats } = require("../src/core/stats.js");
const { renderReport } = require("../src/report/report.js");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src", "cli.js");

/* ── parseCsv 契约验收 ── */

test('验收 P1: 双引号转义（"" → "）', () => {
  const rows = parseCsv('a,"say ""hi""",b');
  assert.deepStrictEqual(rows, [["a", 'say "hi"', "b"]]);
});

test("验收 P2: 引号字段内含换行（多行字段合成一行）", () => {
  const rows = parseCsv('"line1\nline2",x');
  assert.deepStrictEqual(rows, [["line1\nline2", "x"]]);
});

test("验收 P3: CRLF 行分隔", () => {
  const rows = parseCsv("a,b\r\nc,d\r\n");
  assert.deepStrictEqual(rows, [["a", "b"], ["c", "d"]]);
});

test("验收 P4: 空输入返回空数组", () => {
  assert.deepStrictEqual(parseCsv(""), []);
});

test("验收 P5: 仅表头一行", () => {
  assert.deepStrictEqual(parseCsv("a,b\n"), [["a", "b"]]);
});

test("验收 P6: 中文与 emoji 原样保留", () => {
  const rows = parseCsv("名字,备注\n张三,好👍");
  assert.deepStrictEqual(rows, [["名字", "备注"], ["张三", "好👍"]]);
});

/* ── columnStats 契约验收（rows[0] 为表头，total=数据行数） ── */

test("验收 S1: 数值列（负数/小数，mean 保留 2 位）", () => {
  const stats = columnStats([["a", "b"], ["1", "-2.5"], ["3", "4"]]);
  assert.strictEqual(stats[0].type, "number");
  assert.strictEqual(stats[0].total, 2);
  assert.strictEqual(stats[0].mean, 2);
  assert.strictEqual(stats[1].type, "number");
  assert.strictEqual(stats[1].min, -2.5);
  assert.strictEqual(stats[1].max, 4);
  assert.strictEqual(stats[1].mean, 0.75);
});

test("验收 S2: 参差行（短行计 missing，total=数据行数）", () => {
  const stats = columnStats([["a", "b"], ["c"], ["d", "x"]]);
  assert.strictEqual(stats[0].total, 2);
  assert.strictEqual(stats[1].total, 2);
  assert.strictEqual(stats[1].missing, 1);
  assert.strictEqual(stats[1].unique, 1);
});

test("验收 S3: 空字符串计 missing；全空列 type=string unique=0", () => {
  const stats = columnStats([["h1", "h2"], [""], ["x", ""]]);
  assert.strictEqual(stats[0].missing, 1);
  assert.strictEqual(stats[1].missing, 2);
  assert.strictEqual(stats[1].type, "string");
  assert.strictEqual(stats[1].unique, 0);
  assert.strictEqual(stats[1].min, null);
});

test("验收 S4: 字符串列 unique 与 null 三件套", () => {
  const stats = columnStats([["name", "city"], ["张三", "北京"], ["李四", "北京"], ["张三", "上海"]]);
  assert.strictEqual(stats[0].type, "string");
  assert.strictEqual(stats[0].unique, 2);
  assert.strictEqual(stats[1].unique, 2);
  assert.strictEqual(stats[0].min, null);
  assert.strictEqual(stats[0].mean, null);
});

/* ── renderReport 契约验收 ── */

test("验收 R1: 报告格式逐字段符合契约（数值列+字符串列）", () => {
  const rows = parseCsv("name,age\n张三,28\n李四,35\n");
  const report = renderReport(rows);
  const lines = report.trim().split("\n");
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^col0: type=string total=2 missing=0 unique=2$/);
  assert.match(lines[1], /^col1: type=number total=2 missing=0 min=28 max=35 mean=31\.5$/);
});

/* ── CLI 端到端验收 ── */

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });
}

test("验收 C1: 数值 CSV 端到端（负数/小数/统计正确）", () => {
  const csv = path.join(ROOT, "acceptance-numeric.csv");
  fs.writeFileSync(csv, "a,b\n1,-2.5\n3,4\n");
  const r = runCli([csv]);
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^col0: type=number total=2 missing=0 min=1 max=3 mean=2$/);
  assert.match(lines[1], /^col1: type=number total=2 missing=0 min=-2\.5 max=4 mean=0\.75$/);
  fs.unlinkSync(csv);
});

test("验收 C2: 多行引号字段端到端（行数不乱）", () => {
  const csv = path.join(ROOT, "acceptance-multiline.csv");
  fs.writeFileSync(csv, 'name,note\n"张三\n(备注)",好\n李四,好\n');
  const r = runCli([csv]);
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^col0: type=string total=2 missing=0 unique=2$/);
  assert.match(lines[1], /^col1: type=string total=2 missing=0 unique=1$/);
  fs.unlinkSync(csv);
});

test("验收 C3: 文件不存在 → exit 1 + 错误提示", () => {
  const r = runCli([path.join(ROOT, "no-such-file.csv")]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not found|不存在|Usage|Error/i);
});

test("验收 C4: 缺少参数 → exit 1", () => {
  const r = runCli([]);
  assert.strictEqual(r.status, 1);
});

test("验收 C5: 空文件端到端 → 空报告不崩溃", () => {
  const csv = path.join(ROOT, "acceptance-empty.csv");
  fs.writeFileSync(csv, "");
  const r = runCli([csv]);
  assert.strictEqual(r.status, 0);
  fs.unlinkSync(csv);
});
