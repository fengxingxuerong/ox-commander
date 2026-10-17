import fs from "node:fs";
import path from "node:path";

const logPath = path.join(process.env.RUNNER_TEMP ?? "/tmp", "probe.log");
let text = "";
try {
  text = fs.readFileSync(logPath, "utf8");
} catch (e) {
  text = `(读不到 probe.log: ${e.message})`;
}
const m = /FIRST_FAILURE_SEG=(\d+)/.exec(text);
const done = text.includes("PROBE_DONE");
const title = m
  ? `第一处失败：第 ${m[1]} 段`
  : done
    ? "全段通过（PROBE_DONE）"
    : "探针被中途杀死（无 PROBE_DONE 标记）";
const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/check-runs`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    name: "diag-report",
    head_sha: process.env.GITHUB_SHA,
    status: "completed",
    conclusion: m || !done ? "failure" : "success",
    output: { title, summary: title, text: text.slice(-64000) },
  }),
});
console.log(res.status, (await res.text()).slice(0, 300));
