import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createLlmClient } = require("../dist-electron/shared/http-clients.js");
const { OrchestratorEngine } = require("../dist-electron/electron/engine/orchestrator.js");
const { Scheduler } = require("../dist-electron/electron/engine/scheduler.js");
const { verifyProject } = require("../dist-electron/electron/engine/verifier.js");
const { getProvider, PROVIDER_CATALOG } = require("../dist-electron/shared/providers.js");
const { DEFAULT_SETTINGS } = require("../dist-electron/shared/types.js");

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(here, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const MODELS = ["deepseek-v4-flash", "sensenova-6.8-flash-lite", "glm-5.2"];
const KEY_VARS = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3"];

function cfgFor(model) {
  return { ...getProvider("sensenova"), defaultModel: model };
}

const REQUIREMENT =
  "做一个命令行待办事项工具：支持添加、列出、完成待办，数据存本地 JSON 文件。用 Node.js + TypeScript 实现。";

async function main() {
  loadDotEnv();
  console.log("== OxCommander 端到端冒烟（真实 SenseNova API）==\n");

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const keyVar = KEY_VARS[i];
    const apiKey = process.env[keyVar] ?? "";
    if (!apiKey) {
      console.log(`✗ [${model}] 缺少 ${keyVar}，跳过`);
      continue;
    }
    console.log(`── 模型 ${model}（key=${keyVar}）──`);
    try {
      const settings = { ...DEFAULT_SETTINGS, llmProvider: "sensenova" };
      const engine = new OrchestratorEngine(
        {
          llm: createLlmClient({ ...cfgFor(model), apiKeyEnvVar: keyVar }, apiKey),
          scheduler: new Scheduler([]),
          verify: (cwd) => verifyProject(settings.verificationCommands, { cwd: () => cwd }),
          settings,
        },
        {
          onStage: (stage) => console.log(`  [阶段] ${stage}`),
          onLog: () => {},
          onTaskStatus: () => {},
          onVerification: () => {},
          onEscalation: () => {},
        },
      );

      const prd = await engine.generatePrd(REQUIREMENT);
      console.log(`  ✓ PRD.goal: ${prd.goal}`);
      console.log(`    features(${prd.features.length}): ${prd.features.slice(0, 3).join(" / ")}`);

      let batches;
      let smoke;
      try {
        /*
         * decompose 交回的是 { batches, smoke } —— 独立样本冒烟和计划一起产出。
         * 这里曾按"直接返回数组"用，于是第一个模型的规划阶段必然抛
         * "batches.reduce is not a function"，而下面按模型逐个 catch 只打一行 ❌，
         * 所以这个脚本看起来在跑，实际从没验过规划。
         */
        ({ batches, smoke } = await engine.decompose(prd));
      } catch (e) {
        if (e && e.lastRaw) {
          console.log(`  [原始返回摘要] ${String(e.lastRaw).replace(/\s+/g, " ").slice(0, 400)}`);
        }
        throw e;
      }
      const total = batches.reduce((n, b) => n + b.length, 0);
      console.log(`  ✓ 任务分解: ${total} 个任务 → ${batches.length} 个批次`);
      console.log(`  ✓ 独立样本冒烟: ${(smoke ?? []).length} 项`);
      batches.forEach((b, bi) =>
        console.log(`    批次${bi + 1}: ${b.map((t) => `${t.id}(${t.zone})`).join(", ")}`),
      );
      console.log(`  ✅ ${model} 全链路 OK`);
    } catch (e) {
      console.log(`  ❌ ${model} 失败: ${e.message}`);
      process.exitCode = 1;
    }
    console.log("");
  }

  const sensenova = PROVIDER_CATALOG.find((p) => p.id === "sensenova");
  console.log(`目录校验: sensenova baseUrl=${sensenova?.baseUrl}, 默认模型=${sensenova?.defaultModel}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
