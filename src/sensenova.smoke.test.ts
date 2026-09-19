import { describe, expect, it } from "vitest";
import { OpenAiCompatibleClient, createSensenovaFailoverClient } from "../shared/http-clients";
import { chatJson } from "../shared/llm-client";
import { getProvider, SENSENOVA_MODELS, type ProviderConfig } from "../shared/providers";
import { parsePrd } from "../shared/schema";

const BASE = "https://token.sensenova.cn/v1";
const KEY = process.env.SENSENOVA_API_KEY ?? "";
const enabled = process.env.OX_SMOKE === "1" && !!KEY;

const MODELS: Array<{ id: string; model: string }> = [
  { id: "sensenova-deepseek-v4-flash", model: "deepseek-v4-flash" },
  { id: "sensenova-6-8-flash-lite", model: "sensenova-6.8-flash-lite" },
  { id: "sensenova-glm-5.2", model: "glm-5.2" },
];

function clientFor(id: string, model: string): OpenAiCompatibleClient {
  const cfg: ProviderConfig = {
    id,
    displayName: model,
    protocol: "openai-compatible",
    baseUrl: BASE,
    defaultModel: model,
    apiKeyEnvVar: "SENSENOVA_API_KEY",
  };
  return new OpenAiCompatibleClient(cfg, KEY);
}

describe.skipIf(!enabled)("SenseNova real API smoke tests", () => {
  for (const m of MODELS) {
    it(`${m.model}: plain chat connectivity`, async () => {
      const res = await clientFor(m.id, m.model).chat({
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        temperature: 0,
      });
      console.log(`[${m.model}] reply=${JSON.stringify(res.content)} tokens=${res.usageTokens ?? "?"}`);
      expect(res.content.length).toBeGreaterThan(0);
    }, 60_000);
  }

  it(
    "deepseek-v4-flash: forced JSON via chatJson + parsePrd",
    async () => {
      const prd = await chatJson(
        clientFor(MODELS[0]!.id, MODELS[0]!.model),
        {
          messages: [
            {
              role: "user",
              content:
                'Convert this requirement into a PRD. Respond with ONLY a JSON object (no markdown fences): {"goal": string, "features": string[], "techStack": string[], "acceptanceCriteria": string[]}. features: 3-5 items, techStack: 2-4 items, acceptanceCriteria: 2-4 items.\n\nRequirement: a tiny CLI todo app',
            },
          ],
        },
        { schemaName: "PRD", validate: parsePrd },
      );
      console.log("[json-mode] goal:", prd.goal);
      console.log("[json-mode] features:", prd.features.join(" | "));
      expect(prd.goal).toBeTruthy();
      expect(prd.features.length).toBeGreaterThanOrEqual(3);
      expect(prd.techStack.length).toBeGreaterThanOrEqual(2);
    },
    90_000,
  );

  it("catalog contains sensenova entry", () => {
    const p = getProvider("sensenova");
    expect(p.baseUrl).toBe(BASE);
    expect(p.defaultModel).toBe("deepseek-v4-flash");
    expect(p.apiKeyEnvVar).toBe("SENSENOVA_API_KEY");
  });

  it(
    "failover client (3 keys x 3 models) answers a real request",
    async () => {
      const client = createSensenovaFailoverClient();
      const res = await client.chat({
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        temperature: 0,
      });
      console.log(`[failover] model=${res.model} reply=${JSON.stringify(res.content)}`);
      expect(res.content.length).toBeGreaterThan(0);
      expect(SENSENOVA_MODELS.map(String)).toContain(res.model.split("/").pop() ?? res.model);
    },
    90_000,
  );
});
