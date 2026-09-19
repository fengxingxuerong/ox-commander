/* Generates scripts/smoke-repair.mjs from smoke-fullchain.mjs by injecting a
 * pre-broken src/broken.js so the verification fails and the repair round +
 * zone routing path gets exercised against the real API. */
const fs = require("node:fs");
let s = fs.readFileSync("scripts/smoke-fullchain.mjs", "utf8");
s = s.replace(
  "ensureWorkspace(root);",
  'ensureWorkspace(root);\n  fs.writeFileSync(path.join(root, "src", "broken.js"), "function ( { syntax error", "utf8");',
);
s = s.replace(
  "const report = await engine.execute(batches, root);",
  'const report = await engine.execute(batches, root);\n  console.log("broken.js after repair:", JSON.stringify(fs.readFileSync(path.join(root, "src", "broken.js"), "utf8").slice(0, 160)));',
);
fs.writeFileSync("scripts/smoke-repair.mjs", s);
console.log("written scripts/smoke-repair.mjs");
