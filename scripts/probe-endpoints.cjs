// 临时：探测 OpenRouter 与 NVIDIA 端点的可用模型（跑完即删）
const targets = [
  {
    name: "nvidia",
    base: "https://integrate.api.nvidia.com/v1",
    key: process.env.NVIDIA_API_KEY || "",
    want: ["z-ai/glm-5.2", "glm-5.2", "zai-org/glm-5.2"],
  },
  {
    name: "openrouter",
    base: "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY || "",
    want: ["stealth/ox-alpha"],
  },
];

async function listModels(t) {
  const auth = { authorization: `Bearer ${t.key}`, "content-type": "application/json" };
  try {
    const res = await fetch(`${t.base}/models`, { headers: auth, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.log(`  GET /models → ${res.status} ${(await res.text()).slice(0, 200)}`);
      return;
    }
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    console.log(`  GET /models → 200, ${data.length} models`);
    const ids = data.map((m) => m.id);
    for (const w of t.want) {
      console.log(`    wanted ${w.padEnd(22)} → ${ids.includes(w) ? "PRESENT" : "absent"}`);
    }
    const preview = ids.filter((id) => /glm|deepseek|qwen|kimi|llama|ox/i.test(id)).slice(0, 14);
    console.log(`    sample: ${preview.join(", ")}`);
  } catch (err) {
    console.log(`  GET /models → error ${String(err.message).slice(0, 140)}`);
  }
}

async function tryChat(t, model) {
  const auth = { authorization: `Bearer ${t.key}`, "content-type": "application/json" };
  try {
    const res = await fetch(`${t.base}/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 16 }),
      signal: AbortSignal.timeout(45000),
    });
    const text = (await res.text()).slice(0, 180).replace(/\s+/g, " ");
    console.log(`    chat ${model.padEnd(24)} → ${res.ok ? "OK  " : "FAIL"} ${res.status} ${text}`);
    return res.ok;
  } catch (err) {
    console.log(`    chat ${model.padEnd(24)} → error ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

(async () => {
  for (const t of targets) {
    console.log(`\n=== ${t.name} (key ${t.key ? t.key.slice(0, 8) + "…(" + t.key.length + ")" : "MISSING"}) ===`);
    if (!t.key) continue;
    await listModels(t);
    for (const m of t.want) {
      if (await tryChat(t, m)) {
        console.log(`    >>> USABLE: ${m}`);
        break;
      }
    }
  }
})();
