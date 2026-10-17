import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const segs = String(pkg.scripts?.verify ?? "")
  .split("&&")
  .map((s) => s.trim())
  .filter(Boolean);
const logPath = path.join(process.env.RUNNER_TEMP ?? "/tmp", "probe.log");
fs.writeFileSync(logPath, "");
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;

async function publish(name, conclusion, title, text) {
  const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name,
      head_sha: sha,
      status: "completed",
      conclusion,
      output: { title, summary: title, text: text.slice(-64000) },
    }),
  });
  if (!res.ok) console.error(`publish ${name} -> HTTP ${res.status}`);
}

for (let i = 0; i < segs.length; i += 1) {
  const seg = segs[i];
  fs.appendFileSync(logPath, `\n===== SEG ${i + 1}/${segs.length}: ${seg} =====\n`);
  console.log(`===== SEG ${i + 1}/${segs.length}: ${seg} =====`);
  const fd = fs.openSync(logPath, "a");
  const r = spawnSync(seg, { shell: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  fs.appendFileSync(logPath, `\n----- SEG ${i + 1} exit=${r.status} signal=${r.signal ?? ""} -----\n`);
  const ok = r.status === 0;
  await publish(
    `diag-seg-${String(i + 1).padStart(2, "0")}`,
    ok ? "success" : "failure",
    `${ok ? "PASS" : "FAIL"} 第 ${i + 1} 段 ${seg}（exit ${r.status}，signal ${r.signal ?? "无"}）`,
    fs.readFileSync(logPath, "utf8").slice(-60000),
  );
  if (!ok) {
    fs.appendFileSync(logPath, `FIRST_FAILURE_SEG=${i + 1}\n`);
    await publish(
      "diag-FIRST-FAILURE",
      "failure",
      `Ubuntu 第一处失败：第 ${i + 1} 段 ${seg}（exit ${r.status}）`,
      fs.readFileSync(logPath, "utf8").slice(-64000),
    );
    process.exit(1);
  }
}
fs.appendFileSync(logPath, "PROBE_DONE\n");
await publish("diag-report", "success", "ubuntu 上 verify 全段通过", fs.readFileSync(logPath, "utf8").slice(-64000));
