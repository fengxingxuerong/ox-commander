/**
 * 判据体检：把 `check-doc-claims.mjs` 的每种失败模式**真的造出来**，确认它会红。
 *
 * 当前 9 条注入 + 1 条正向对照（条数由脚本自己打印，别在别处再抄一份 ——
 * 本脚本自己的锚点就漂过一次，见下面 SEGMENTS 那段注释）。
 *
 * 为什么留成脚本而不是"跑过一次就写进文档"：门禁的 PASS 本身需要证据，而
 * 「我手改了一下看到红了」这种记录不可复跑 —— 下一个人改判据时没有任何东西告诉他
 * 判据是不是被写瞎了。与本仓 `--selftest`（判据的判据）同一纪律，只是这里要动真文件，
 * 所以不进 `verify`（它会临时改 README / gates.md / package.json），改完 `check:doc-claims`
 * 之后手动跑一次。
 *
 * 结构：先跑**正向对照**（不注入必须绿），再逐条注入 → 跑门禁 → 立刻在 `finally` 里
 * 从内存原文还原，最后逐文件哈希核对。⚠️ 若进程被中途强杀，会留下一处被注入的锚点 ——
 * 下一次跑本脚本时正向对照会当场判红并告诉你哪个数字不对（这就是把正向对照放在最前面的理由）。
 *
 * 用法：node scripts/doc-claims-injection.mjs     （全部按预期变红则 exit 0）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATES = path.join(".qoder", "skills", "ox-commander-dev", "references", "gates.md");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

function runGate() {
  const r = spawnSync(process.execPath, ["scripts/check-doc-claims.mjs", "--selftest"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * 注入点里的段数**从 package.json 现算**，不是写死在这儿的字面量。
 *
 * 这不是洁癖：本脚本自己就漂过一次 —— 链从 27 段加到 28 段之后，三条用例的锚点
 * 全部 0 命中，报的是"构造没成立"而不是"判据失效"，差别只在有没有人去读那三行。
 * 写死的数字在这里会变成**第二个会过期的副本**，与被这道门禁管着的文档一模一样。
 */
const SEGMENTS = String(
  JSON.parse(read("package.json")).scripts.verify,
).split("&&").length;
const STALE_SEGMENTS = SEGMENTS - 5; // 故意写成一个不等旧值（用它自己的历史数字）
/** 汉字写法：用来造「措辞漂到读不到」那种失效，判据必须红而不是放过。 */
const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const SEGMENTS_CN = String(SEGMENTS)
  .split("")
  .map((d) => CN_DIGITS[Number(d)])
  .join("");

/** 用例数与变异规模的锚点同样从实物派生（同一理由：写死就会跟着漂）。 */
const README_NOW = read("README.md");
const PASSED = Number((/(\d+)\s*通过\s*\+\s*(\d+)\s*跳过/.exec(README_NOW) || [])[1] || 0);
const TOTAL = Number((/合计\s*(\d+)\s*条/.exec(README_NOW) || [])[1] || 0);
const SCALE = JSON.parse(
  spawnSync(process.execPath, ["scripts/site-baseline.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim(),
);
if (!PASSED || !TOTAL || !SCALE.targets || !SCALE.baselineSites) {
  console.error(
    `FAIL: 锚点派生失败（通过数 ${PASSED} / 合计 ${TOTAL} / 规模 ${JSON.stringify(SCALE)}）—— ` +
      "文档里那几个形状不在了，先确认是判据变了还是措辞变了，别把构造没成立当成通过。",
  );
  process.exit(1);
}

/** 每条都是「一种真实会发生的漂移」，不是随机破坏：注入点与期望命中的判据一一对应。 */
const CASES = [
  {
    n: `段数漂（README 把段数写少 1）`,
    f: "README.md",
    from: `**${SEGMENTS} 段**`,
    to: `**${SEGMENTS - 1} 段**`,
    want: "【段数】",
  },
  {
    n: "历史数字紧贴「段」字（叙述里写旧段数）",
    f: GATES,
    from: `（${SEGMENTS} 段）`,
    to: `（${SEGMENTS} 段）与旧数 ${STALE_SEGMENTS} 段的对比`,
    want: "【段数】",
  },
  {
    n: "用例数漂（README 少写 94 条）",
    f: "README.md",
    from: `${PASSED} 通过`,
    to: `${PASSED - 94} 通过`,
    want: "【不一致】",
  },
  {
    n: "算术漂（合计与两半不自洽）",
    f: "README.md",
    from: `合计 ${TOTAL} 条`,
    to: `合计 ${TOTAL - 3} 条`,
    want: "【算术】",
  },
  {
    n: "清单漏行（README 里 field-orphans 那行改名）",
    f: "README.md",
    from: "→ check:field-orphans（",
    to: "→ 新来的那道门（",
    want: "【漏行】",
  },
  {
    n: "措辞漂到判据读不到（数字改成汉字）",
    f: "README.md",
    from: `**${SEGMENTS} 段**`,
    to: `**${SEGMENTS_CN}段**`,
    want: "解析不到任何段数声明",
  },
  {
    n: "verify 串里出现重复段",
    f: "package.json",
    from: "npm run lint",
    to: "npm run lint && npm run lint",
    want: "重复段",
  },
  {
    n: "在册目标数漂（README 写回旧规模）",
    f: "README.md",
    from: `当前在册 **${SCALE.targets} 个目标**`,
    to: `当前在册 **${STALE_SEGMENTS} 个目标**`,
    want: "【目标数】",
  },
  {
    n: "基线位点数漂（README 写回旧规模）",
    f: "README.md",
    from: `基线 **${SCALE.baselineSites} 处位点**`,
    to: `基线 **${SCALE.baselineSites - 449} 处位点**`,
    want: "【位点数】",
  },
];

const originals = new Map(CASES.map((c) => [c.f, read(c.f)]));
const report = [];
let bad = 0;

try {
  const pos = runGate();
  if (pos.code !== 0) {
    console.error(
      "FAIL: 正向对照（不注入）就没绿 —— 后面的注入结果全部不可信。\n" +
        "     若上一轮本脚本被中途强杀，这里就是它留下的现场；按报错把那个文件改回去再跑。\n",
    );
    console.error(pos.out.slice(-1500));
    process.exit(1);
  }
  report.push("✓ 正向对照：不注入时门禁为绿（否则下面的「全红」只是探针坏了）");

  for (const c of CASES) {
    const base = originals.get(c.f);
    const hits = base.split(c.from).length - 1;
    if (hits !== 1) {
      bad += 1;
      report.push(`✗ ${c.n}：锚点在 ${c.f} 里命中 ${hits} 次 —— 构造没成立（文档措辞变了？）`);
      continue;
    }
    fs.writeFileSync(path.join(ROOT, c.f), base.replace(c.from, () => c.to), "utf8");
    let r;
    try {
      r = runGate();
    } finally {
      fs.writeFileSync(path.join(ROOT, c.f), base, "utf8");
    }
    const line =
      r.out.split(/\r?\n/).find((l) => l.trim().startsWith("- 【")) ||
      r.out.split(/\r?\n/).find((l) => l.includes("FAIL:")) ||
      "";
    const ok = r.code === 1 && r.out.includes(c.want);
    if (!ok) bad += 1;
    report.push(`${ok ? "✓" : "✗"} ${c.n} → exit=${r.code}，命中：${line.trim().slice(0, 80)}`);
  }
} finally {
  for (const [rel, text] of originals) {
    const now = read(rel);
    if (sha(now) !== sha(text)) {
      console.error(`\n还原失败：${rel} 哈希不一致（原 ${sha(text)} 现 ${sha(now)}）—— 手工改回去。`);
      bad += 1;
    }
  }
}

console.log(report.join("\n"));
console.log(`\n反向注入 ${CASES.length} 条：判据按预期变红 ${CASES.length - bad}/${CASES.length}`);
if (bad > 0) {
  console.error(`有 ${bad} 条不如预期 —— 要么判据空转，要么构造/锚点已过期。`);
  process.exit(1);
}
