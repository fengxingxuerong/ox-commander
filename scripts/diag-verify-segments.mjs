import { spawnSync } from "node:child_process";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const segs = String(pkg.scripts?.verify ?? "")
  .split("&&")
  .map((s) => s.trim())
  .filter(Boolean);
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
  if (!res.ok) {
    console.error(`check-run ${name} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const summary = [];
for (let i = 0; i < segs.length; i += 1) {
  const seg = segs[i];
  const t0 = Date.now();
  const r = spawnSync(seg, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  summary.push(`${ok ? "PASS" : "FAIL"}  ${String(i + 1).padStart(2)}  ${seg}  (exit ${r.status}, ${secs}s)`);
  console.log(`=== [${i + 1}/${segs.length}] ${seg} => exit ${r.status} (${secs}s) ===`);
  console.log(out.slice(-2500));
  await publish(
    `diag-seg-${String(i + 1).padStart(2, "0")}`,
    ok ? "success" : "failure",
    `${ok ? "PASS" : "FAIL"} 第 ${i + 1} 段 ${seg}（exit ${r.status}，${secs}s）`,
    `${summary.join("\n")}\n\n--- 段输出尾部 ---\n${out.slice(-30000)}`,
  );
  if (!ok) {
    await publish(
      "diag-FIRST-FAILURE",
      "failure",
      `Ubuntu 上第一处失败：第 ${i + 1} 段 ${seg}`,
      `${summary.join("\n")}\n\n--- 失败段输出尾部 ---\n${out.slice(-30000)}`,
    );
    process.exit(1);
  }
}
await publish("diag-all-pass", "success", "ubuntu 上 verify 全段通过", summary.join("\n"));
