/**
 * 生成 `oxcommander serve` 的 systemd 单元文件（C7 · 2026-10-24）。
 *
 * 为什么是"生成器"而不是"安装器"：装进 systemd（拷贝、daemon-reload、enable）
 * 是改变机器状态的动权动作，该由人看着做；而单元文件里有一堆**安全判据**
 * （回环绑定、token 不落单元、strict 与可写路径成对）—— 生成器把这些判据
 * 固化成同一份出处，人只需要审一眼输出。下一步命令由脚本打印，不代跑。
 *
 * 用法：
 *   node scripts/serve-install.mjs [--out=<path>] [--port=8787]
 *     [--app-dir=/opt/oxcommander] [--node=/usr/bin/node] [--user=oxcommander]
 *     [--every=30m --spec=/abs/nightly.json] [--selftest]
 *
 * 判据（自检逐条钉住）：
 *   1. token **永不进单元**：生成器根本不收 token 参数；鉴权走
 *      EnvironmentFile（默认 /etc/oxcommander/serve.env，放置说明在尾注 checklist）。
 *   2. ExecStart 显式 `--host=127.0.0.1`：对公网的暴露是反向代理的职责，
 *      服务本身永远只听回环 —— 改它必须是人手改单元，而不是生成器给默认值。
 *   3. `ProtectSystem=strict` 必须与 `ReadWritePaths=${STATE_DIRECTORY}` 成对：
 *      只 strict 不开写路径，定时状态文件第一次落盘就把服务写崩。
 *   4. `--every` 与 `--spec` 成对或都不出现（与 serve-main 的 parseScheduleArgs
 *      同一条纪律：半个定时配置不许静默变成"没配定时"）。
 *   5. schedule-state 落在 systemd 的 StateDirectory 里（${STATE_DIRECTORY}），
 *      不落在应用目录（ProtectSystem=strict 下应用目录不可写）。
 */
import fs from "node:fs";
import path from "node:path";

const LOOPBACK = "127.0.0.1";

function args(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a === "--selftest") out.selftest = true;
  }
  return out;
}

/**
 * 生成单元文件文本。纯字符串拼装，判据都在字段选择上 —— 自检断言的就是
 * 这些字段必须出现（或必须不出现）的形态。
 */
export function buildUnit(opts) {
  const port = opts.port ?? 8787;
  const appDir = opts.appDir ?? "/opt/oxcommander";
  const nodeBin = opts.node ?? "/usr/bin/node";
  const user = opts.user ?? "oxcommander";
  const every = opts.every;
  const spec = opts.spec;

  // 判据 4：半个定时配置在这里就抛 —— 生成器是判据的出处，不等人审出来。
  if ((every !== undefined) !== (spec !== undefined)) {
    throw new Error("--every 与 --spec 必须成对出现（与 serve-main 的定时参数同一条纪律）");
  }

  const scheduleFlags =
    every !== undefined
      ? ` --every=${every} --spec=${spec} --schedule-state=\${STATE_DIRECTORY}/schedule-state.json`
      : "";

  return [
    "[Unit]",
    "Description=OxCommander serve (headless 常驻服务，回环监听，鉴权走环境文件)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `Type=simple`,
    `User=${user}`,
    "StateDirectory=oxcommander",
    "# token 放这里（不要写进本单元）：/etc/oxcommander/serve.env 一行",
    "#   OX_SERVE_TOKEN=<一串你自己生成的随机值>   # chmod 600",
    "EnvironmentFile=-/etc/oxcommander/serve.env",
    `ExecStart=${nodeBin} ${appDir}/dist-headless/headless/serve-main.js --port=${port} --host=${LOOPBACK}${scheduleFlags}`,
    "WorkingDirectory=" + appDir,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
    "ReadWritePaths=${STATE_DIRECTORY}",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** 下一步 checklist：打印给人执行，脚本不代跑（装进 systemd 是动权动作）。 */
export function nextSteps(opts) {
  const out = opts.out ?? "/etc/systemd/system/oxcommander-serve.service";
  return [
    "下一步（由你执行，本脚本不代跑）：",
    `  1. 安装单元：  cp <输出> ${out} && systemctl daemon-reload`,
    "  2. 放 token：  install -d -m 700 /etc/oxcommander && printf 'OX_SERVE_TOKEN=%s\\n' '<随机值>' > /etc/oxcommander/serve.env && chmod 600 /etc/oxcommander/serve.env",
    "  3. 起服务：    systemctl enable --now oxcommander-serve",
    "  4. 本机验证：  curl -s http://127.0.0.1:8787/ >/dev/null && echo no-token-rejected? || echo ok",
    "     （无 token 应被拒；带 token 用 -H 'Authorization: Bearer <token>' 应看到状态页）",
    "  5. 公网入口：  用反代终结 TLS 并转发到 127.0.0.1:8787（示例见 docs/serve-deploy.md），",
    "     服务本身保持回环监听 —— 这是单元里 --host=127.0.0.1 的用意，别改。",
  ];
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function selftest() {
  const failures = [];
  const unit = buildUnit({});
  // 判据 1：单元里 OX_SERVE_TOKEN 只许出现在注释行（放置指引）；
  // 出现在任何生效行 = token 被写进了单元 —— 生成器没有 token 入参，这是结构性保证。
  const tokenLines = unit.split("\n").filter((l) => l.includes("OX_SERVE_TOKEN"));
  if (tokenLines.length === 0 || tokenLines.some((l) => !l.trimStart().startsWith("#"))) {
    failures.push(`OX_SERVE_TOKEN 只许出现在注释行，实际：${JSON.stringify(tokenLines)}`);
  }
  // 判据 2：--host 只有回环一种取值。
  const hosts = [...unit.matchAll(/--host=([^\s]+)/g)].map((m) => m[1]);
  if (hosts.length !== 1 || hosts[0] !== LOOPBACK) {
    failures.push(`--host 必须且只能是 ${LOOPBACK}，实际：${JSON.stringify(hosts)}`);
  }
  // ExecStart 指到 serve-main.js 的绝对路径形态。
  if (!/ExecStart=\S+ \S+\/dist-headless\/headless\/serve-main\.js /.test(unit)) {
    failures.push("ExecStart 必须指向 <app>/dist-headless/headless/serve-main.js");
  }
  // 判据 3：strict 与可写路径成对。
  if (!unit.includes("ProtectSystem=strict") || !unit.includes("ReadWritePaths=${STATE_DIRECTORY}")) {
    failures.push("ProtectSystem=strict 必须与 ReadWritePaths=${STATE_DIRECTORY} 成对出现");
  }
  // 判据 5：schedule-state 在状态目录。
  const sched = buildUnit({ every: "30m", spec: "/etc/oxcommander/nightly.json" });
  if (!sched.includes("--schedule-state=${STATE_DIRECTORY}/schedule-state.json")) {
    failures.push("--schedule-state 必须落在 ${STATE_DIRECTORY}");
  }
  if (!sched.includes("--every=30m") || !sched.includes("--spec=/etc/oxcommander/nightly.json")) {
    failures.push("--every 与 --spec 必须成对进入 ExecStart");
  }
  // 半个定时配置 = 生成器直接抛（上面判据 4），自检断言抛的是那句话。
  let halfThrew = "";
  try {
    buildUnit({ every: "30m" });
  } catch (e) {
    halfThrew = String(e.message);
  }
  if (!halfThrew.includes("必须成对")) {
    failures.push(`--every 缺 --spec 必须在生成器里就抛错，实际：${JSON.stringify(halfThrew)}`);
  }
  // checklist 必须提到 daemon-reload 与回环保持。
  const steps = nextSteps({});
  if (!steps.some((s) => s.includes("daemon-reload"))) failures.push("checklist 缺 daemon-reload");
  if (!steps.some((s) => s.includes("127.0.0.1"))) failures.push("checklist 缺回环验证一步");
  if (failures.length > 0) fail("serve-install 自检未通过：\n  " + failures.join("\n  "));
  console.log("PASS: serve-install 自检通过（单元判据 5 组 + checklist 2 项）");
}

const opts = args(process.argv.slice(2));
if (opts.selftest) {
  selftest();
  process.exit(0);
}

let unit;
try {
  unit = buildUnit(opts);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
}
if (opts.out) {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, unit, "utf8");
  console.log(`已写入 ${opts.out}`);
} else {
  process.stdout.write(unit);
}
for (const line of nextSteps(opts)) console.log(line);
