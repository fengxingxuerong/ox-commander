const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const { SensenovaApiAdapter } = require(
  path.join(repoRoot, "dist-electron", "electron", "agents", "sensenova-api.js"),
);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-snap-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const SECRET = "sk-REAL-SECRET-abcdef123456";
  const NVIDIA = "nvapi-SECRET-abcd1234efgh5678";
  fs.writeFileSync(path.join(root, ".env"), "SENSENOVA_API_KEY=" + SECRET + "\n");
  fs.writeFileSync(path.join(root, "credentials.json"), '{"token":"' + NVIDIA + '"}');
  fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# normal doc\n");

  let capturedPrompt = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedPrompt += String(init && init.body ? init.body : "");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"choices":[{"message":{"content":"{\\"files\\":[]}"}}]}',
      json: async () => ({ choices: [{ message: { content: '{"files":[]}' } }] }),
    };
  };
  process.env.SENSENOVA_API_KEY = "sk-DUMMY-000000000000";
  const adapter = new SensenovaApiAdapter();
  const handle = await adapter.dispatch({
    runId: "e2e-1",
    taskId: "t1",
    title: "T",
    description: "write code",
    zone: "src",
    projectRoot: root,
  });
  for await (const ev of adapter.collect(handle)) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "aborted") break;
  }
  globalThis.fetch = realFetch;

  const checks = [
    ["prompt excludes .env secret value", !capturedPrompt.includes(SECRET)],
    ["prompt excludes credentials.json token", !capturedPrompt.includes(NVIDIA)],
    ["prompt excludes .env filename", !capturedPrompt.includes(".env")],
    ["prompt still includes normal source index.js", capturedPrompt.includes("index.js")],
    ["prompt still includes normal doc README.md", capturedPrompt.includes("README.md")],
    ["prompt was actually built (non-empty)", capturedPrompt.length > 0],
  ];
  let bad = 0;
  for (const pair of checks) {
    console.log((pair[1] ? "PASS: " : "FAIL: ") + pair[0]);
    if (!pair[1]) bad++;
  }
  console.log(bad === 0 ? "\nE2E SNAPSHOT: all checks passed" : "\nE2E SNAPSHOT: " + bad + " FAILED");
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error("E2E ERROR:", e && e.message);
  process.exit(2);
});
