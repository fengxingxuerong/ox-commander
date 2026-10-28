/**
 * 凭据库回放门的端到端冒烟（第七轮竞品吸收 · 凭据回放门）。
 *
 * 为什么要有它：`receipt-regress-main.ts` 是**一整批**凭据的裁决入口，整层是 IO 胶水
 * （扫目录、按文件名挑、逐份审计、把一批裁决归并成一档、可选复跑）。单测覆盖的是
 * `shared/receipt-lib.ts` 的纯逻辑；胶水错了（把"最严重的一档"实现成"第一份/最后一份的
 * 一档"、`--limit` 挑成最旧的、默认定模式偷偷复跑）单测一律看不见 —— 而退出码是下游
 * 流水线唯一消费的东西。
 *
 * 边界：被测对象是 `dist-headless` 里的**编译产物**，以子进程运行（真 argv、真目录、
 * 真退出码）。不做进程内 import —— 那个入口 import 即执行。
 *
 * 每个复跑类用例都带**非空转证据**：命令会写标记文件，断言标记存在才算"真的跑了"；
 * 默认模式用例反过来断言标记**不存在**（证明没偷偷复跑）。
 *
 * 用法：node scripts/receipt-regress-smoke.mjs
 *   前置：npm run build:headless（消费 dist-headless 的产物）
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist-headless", "headless", "receipt-regress-main.js");
const LIB = path.join(ROOT, "dist-headless", "shared", "delivery-receipt.js");

if (!fs.existsSync(CLI)) {
  console.error(`FAIL: 找不到 ${path.relative(ROOT, CLI)} —— 先跑 npm run build:headless`);
  process.exit(1);
}

/** 指纹用**产物里的**生产实现算，而不是在本脚本里重写一遍算法。 */
const { sealReceipt } = createRequire(import.meta.url)(LIB);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------- 凭据构造 */

function makeReceipt(over = {}) {
  return {
    outcome: "delivered",
    verified: true,
    rounds: 0,
    checks: [],
    tasks: [],
    conflicts: [],
    counts: {
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      conflicts: 0,
      checksFailed: 0,
      preexisting: 0,
    },
    headline: "已交付：0/0 个任务完成",
    ...over,
  };
}

/** 一条带命令的凭据检查（可被 --replay 复跑）。 */
const commandCheck = (kind, script) => ({
  kind,
  ok: true,
  exitCode: 0,
  preexisting: false,
  headline: "",
  command: "node",
  args: [script],
});

/* --------------------------------------------------------------- 跑 CLI */

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let failures = 0;

async function expect(label, args, want, probe, workdir) {
  const res = await runCli(args, workdir);
  const probes = probe ? probe(res) : [];
  const badProbe = probes.filter((p) => !p.ok);
  const codeOk = res.code === want;
  const ok = codeOk && badProbe.length === 0;
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}`);
    if (!codeOk) console.log(`      退出码 期望 ${want} / 实际 ${res.code}`);
    for (const p of badProbe) console.log(`      断言失败：${p.what}`);
    console.log(`      stdout: ${res.stdout.split("\n").slice(0, 14).join(" / ")}`);
    if (res.stderr.trim()) console.log(`      stderr: ${res.stderr.trim().split("\n").slice(-4).join(" / ")}`);
  }
  return res;
}

const has = (text, needle, what) => ({ ok: text.includes(needle), what: `${what ?? needle}（输出里没出现）` });

/* ---------------------------------------------------------------- 用例 */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-regress-smoke-"));
  const lib = path.join(tmp, "lib");
  fs.mkdirSync(lib);
  // 复跑用的真实脚本：先落标记，再决定退出码 —— 标记本身就是"真的执行过"的证据。
  fs.writeFileSync(path.join(lib, "ok.js"), 'require("fs").writeFileSync("marker-ok.txt","");\n');
  fs.writeFileSync(path.join(lib, "ok2.js"), 'require("fs").writeFileSync("marker-ok2.txt","");\n');
  // 默认模式若误去复跑，这个标记就会冒出来
  fs.writeFileSync(path.join(lib, "sentinel.js"), 'require("fs").writeFileSync("marker-sentinel.txt","");\n');

  const marker = (n) => fs.existsSync(path.join(lib, n));

  /**
   * 按约定命名写一份凭据：`<stamp>-<指纹前 8 位>.json`。
   * 返回文件名（断言里要按名字指认是哪一份）。
   */
  const put = (dir, stamp, receipt) => {
    const sealed = sealReceipt(receipt, sha256);
    const name = `${stamp}-${sealed.fingerprint.slice(0, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(sealed, null, 2));
    return { name, file: path.join(dir, name), sealed };
  };

  const freshDir = (tag) => {
    const d = path.join(tmp, tag);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ① 目录不存在 → exit 1（用不了，而不是"通过"）
  await expect(
    "T1 目录不存在：exit 1 并说清约定",
    [`--dir=${path.join(tmp, "no-such-dir")}`],
    1,
    (res) => [has(res.stderr, "凭据库目录不存在", "说明了目录不存在"), has(res.stderr, ".ox/receipts", "给出了约定路径")],
  );

  // ② 空目录（只有不认得的文件名）→ exit 1：没有凭据 ≠ 通过
  {
    const d = freshDir("empty");
    fs.writeFileSync(path.join(d, "README.md"), "not a receipt\n");
    await expect("T2 目录里没有可解析的凭据：exit 1（不是 0）", [`--dir=${d}`], 1, (res) => [
      has(res.stderr, "没有可解析的凭据", "说清了没有凭据"),
      has(res.stdout, "README.md", "把跳过的文件名说破了"),
    ]);
  }

  // ③ 一份没盖章的 → 整批 unsigned（4）
  {
    const d = freshDir("unsigned");
    const raw = makeReceipt({ checks: [commandCheck("test", "sentinel.js")] });
    fs.writeFileSync(path.join(d, "20261026-100000-deadbeef.json"), JSON.stringify(raw, null, 2));
    await expect("T3 没盖章的凭据：整批判 unsigned", [`--dir=${d}`], 4, (res) => [
      has(res.stdout, "unsigned", "逐份打印了 unsigned"),
      has(res.stdout, "整批裁决：unsigned", "整批取该档"),
    ]);
  }

  // ④ 一份被改过的 → tampered（3）
  {
    const d = freshDir("tampered");
    const { file } = put(d, "20261026-100000", makeReceipt());
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    obj.headline = "被改过的结论";
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    await expect("T4 盖章后改动内容：判 tampered", [`--dir=${d}`], 3, (res) => [
      has(res.stdout, "tampered", "逐份打印了 tampered"),
    ]);
  }

  // ⑤ 默认模式（不给 --replay）：整批 not-replayed（5），且**绝不执行任何命令**
  {
    const d = freshDir("noreplay");
    put(d, "20261026-100000", makeReceipt({ checks: [commandCheck("test", "sentinel.js")] }));
    await expect("T5 默认不复跑：判 not-replayed，且命令一次都没执行", [`--dir=${d}`], 5, (res) => [
      has(res.stdout, "not-replayed", "裁决为 not-replayed"),
      { ok: !marker("marker-sentinel.txt"), what: "默认模式下没有任何命令被执行" },
    ]);
  }

  // ⑥ --replay：复跑复现 → verified（0），标记为证
  {
    const d = freshDir("verified");
    put(d, "20261026-100000", makeReceipt({ checks: [commandCheck("test", "ok.js")] }));
    await expect(
      "T6 --replay 复跑复现：整批 verified（命令真的跑过）",
      [`--dir=${d}`, "--replay", `--cwd=${lib}`],
      0,
      (res) => [
        has(res.stdout, "verified", "裁决为 verified"),
        { ok: marker("marker-ok.txt"), what: "被复跑的命令留下了标记（证明真执行）" },
      ],
    );
  }

  // ⑦ 一批里"一份坏 + 一份好" → 取**最严重**的那档（这是整批语义的核心）
  {
    const d = freshDir("mixed");
    // 好的一份（时间更早）
    put(d, "20261026-100000", makeReceipt({ checks: [commandCheck("test", "ok.js")] }));
    // 坏的一份（时间更晚）：盖章后改内容 ⇒ tampered
    const bad = put(d, "20261026-110000", makeReceipt());
    const obj = JSON.parse(fs.readFileSync(bad.file, "utf8"));
    obj.outcome = "blocked";
    fs.writeFileSync(bad.file, JSON.stringify(obj, null, 2));
    await expect(
      "T7 一份 tampered + 一份 verified：整批判 tampered（最严重的那档）",
      [`--dir=${d}`, "--replay", `--cwd=${lib}`],
      3,
      (res) => [
        has(res.stdout, "tampered", "打印了 tampered"),
        has(res.stdout, "verified", "也打印了那份好的"),
        has(res.stdout, "整批裁决：tampered", "整批取最严重的一档"),
      ],
    );
  }

  // ⑧ --limit=1 挑**最新**那一份（按文件名里的时间戳，不是 mtime）
  {
    const d = freshDir("limit");
    // 每个复跑用例用**自己的**标记文件：共用会让"更早那份没被跑"这条断言被前面的
    // 用例污染成假红（T6 已经留下过 marker-ok.txt）。
    fs.writeFileSync(path.join(lib, "old.js"), 'require("fs").writeFileSync("marker-old.txt","");\n');
    fs.writeFileSync(path.join(lib, "new.js"), 'require("fs").writeFileSync("marker-new.txt","");\n');
    put(d, "20261026-100000", makeReceipt({ checks: [commandCheck("test", "old.js")] }));
    put(d, "20261026-110000", makeReceipt({ checks: [commandCheck("test", "new.js")] }));
    await expect(
      "T8 --limit=1 只跑最新那份（按文件名时间戳挑，不看 mtime）",
      [`--dir=${d}`, "--limit=1", "--replay", `--cwd=${lib}`],
      0,
      (res) => [
        { ok: marker("marker-new.txt"), what: "最新的那一份被跑了" },
        { ok: !marker("marker-old.txt"), what: "更早的那一份没被跑（limit 生效）" },
        has(res.stdout, "共 1 份", "只挑了 1 份"),
      ],
    );
  }

  // ⑨ 读不动的凭据：如实报坏、整批 exit 1，**不被"别的都好"糊过去**
  {
    const d = freshDir("broken");
    put(d, "20261026-100000", makeReceipt());
    fs.writeFileSync(path.join(d, "20261026-110000-aaaaaaaa.json"), "{ 不是 JSON");
    await expect(
      "T9 目录里有一份读不动：exit 1 并逐份点名",
      [`--dir=${d}`],
      1,
      (res) => [
        has(res.stdout, "读不动", "把读不动的那份说破了"),
        has(res.stdout, "unreadable=1", "统计里记了 1 份读不动"),
      ],
    );
  }

  // ⑩ --limit 非法 → exit 1（用不了，不是"没复跑"）
  await expect("T10 --limit=abc：exit 1", [`--limit=abc`], 1, (res) => [
    has(res.stderr, "--limit=abc 非法", "说明 limit 非法"),
  ]);

  // 收尾：只删本脚本自己造的目录
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? "\n凭据回放门冒烟全部通过 ✅" : `\n凭据回放门冒烟失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("冒烟自身故障（非被测代码失败）:", e);
  process.exit(1);
});
