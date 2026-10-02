/**
 * LLM 故障转移靶场（target range）—— 本地故障注入端点集合。
 *
 * 为什么要有它：failover.test.ts 的 stub 只能证明 `FailoverLlmClient` 对
 * "被注入的错误对象"做出正确反应；靶场补的是**真实 HTTP 链路**这一层 ——
 * 真 fetch、真 TCP、真 AbortSignal 超时、真 Retry-After 响应头、真截断字节流。
 * 故障由靶场服务器按"剧本"逐步注入，客户端是 `dist-headless` 编译产物里的
 * 生产代码（不是测试替身）。
 *
 * 靶场端点：一个 node:http 服务器按路径扮演多 provider × 多端点矩阵
 * （`/p<N>/v1/chat/completions`），每个端点挂一份剧本（steps 数组，按命中
 * 次数逐个执行，耗尽后钳底重复）：
 *
 *   ok            200 + 合法 OpenAI 响应体
 *   status:<code> HTTP <code>（可选 `+retryafter:<秒>` 附 Retry-After 头）
 *   slow:<ms>     延迟 <ms> 后 200（在客户端超时内的"慢但活着"）
 *   hang:<ms>     挂起 <ms> 才响应（超过客户端超时 → 真超时轮换）
 *   malformed     200 + HTML 体（JSON.parse 失败 → MalformedResponseError）
 *   truncate      200 + 截断的 JSON 体（同上）
 *
 * 场景矩阵（17 个）覆盖：429/5xx 轮换、Retry-After 尊重、认证 fail-fast
 * （单 provider）与跨 provider 只 bench、402/404/410 线路级 bench、
 * 挂起超时、畸形/截断响应、全池冷却 → AllRoutesCoolingError、冷却到期
 * 恢复、连续失败升级冷却、成功清零、取消不冷却、速度画像排序、jsonMode
 * 下传、以及一条 5 端点连坏的混沌链。
 *
 * 用法：node scripts/llm-target-range-it.mjs
 *   前置：npm run build:headless（消费 dist-headless/shared/http-clients.js）
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROD = path.join(ROOT, "dist-headless", "shared", "http-clients.js");

if (!fs.existsSync(PROD)) {
  console.error("FAIL: 找不到 dist-headless/shared/http-clients.js —— 先跑 npm run build:headless");
  process.exit(1);
}

// 被测对象是**编译产物里的生产代码**，不是测试替身
const require_ = createRequire(import.meta.url);
const {
  FailoverLlmClient,
  MalformedResponseError,
  HttpLlmError,
  AllRoutesCoolingError,
  createLlmClient,
} = require_(PROD);

/* ---------------------------------------------------------------- 靶场服务器 */

/**
 * 一个靶场 = 一个 HTTP 服务器 + 端点剧本表 + 命中记账。
 * 每个用例自建一个（端口 0 = 随机），互不串线。
 */
function startTargetRange(scripts) {
  // scripts: { [endpoint]: string[] }，endpoint 形如 "p1"（完整路径 /p1/v1/chat/completions）
  const hits = new Map(); // endpoint -> 命中次数
  const bodies = new Map(); // endpoint -> 最近一次请求体（字符串）
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    // /p1/v1/chat/completions → 端点名 p1
    const endpoint = url.pathname.split("/").filter(Boolean)[0] ?? "";
    const script = scripts[endpoint];
    if (!script) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no script for ${endpoint}` } }));
      return;
    }
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.set(endpoint, Buffer.concat(chunks).toString("utf8"));
      const idx = hits.get(endpoint) ?? 0;
      hits.set(endpoint, idx + 1);
      fireStep(res, script[Math.min(idx, script.length - 1)]);
    });
    // 客户端超时掐断后，继续写已死的 socket 会炸 —— 靶场必须吞掉
    res.on("error", () => {});
    req.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        hits: (e) => hits.get(e) ?? 0,
        body: (e) => bodies.get(e) ?? "",
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function fireStep(res, step) {
  if (step === "ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        model: "target-m",
        usage: { total_tokens: 5 },
      }),
    );
    return;
  }
  if (step.startsWith("status:")) {
    const [codePart, raPart] = step.slice(7).split("+");
    const code = Number(codePart);
    const headers = { "content-type": "application/json" };
    if (raPart?.startsWith("retryafter:")) headers["retry-after"] = raPart.slice(11);
    res.writeHead(code, headers);
    res.end(JSON.stringify({ error: { message: `injected ${code}` } }));
    return;
  }
  if (step.startsWith("slow:")) {
    setTimeout(() => fireStep(res, "ok"), Number(step.slice(5)));
    return;
  }
  if (step.startsWith("hang:")) {
    // 挂起超过客户端超时；socket 会被对方掐断，写失败由上面的 error 吞掉
    setTimeout(() => fireStep(res, "ok"), Number(step.slice(5)));
    return;
  }
  if (step === "malformed") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>gateway error page</body></html>");
    return;
  }
  if (step === "truncate") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"content":"to'); // 戛然而止
    return;
  }
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `unknown step ${step}` } }));
}

/* ------------------------------------------------------------ 客户端构造 */

/** 一条"线路"= 靶场上的一个端点 + 生产 OpenAiCompatibleClient。 */
function makeEndpoint(range, name, timeoutMs) {
  const config = {
    id: name,
    displayName: `靶场-${name}`,
    protocol: "openai-compatible",
    baseUrl: `${range.baseUrl}/${name}/v1`,
    defaultModel: `m-${name}`,
    apiKeyEnvVar: "TARGET_RANGE_KEY", // 非空才会带 Bearer 头，与生产形态一致
  };
  return createLlmClient(config, "target-range-key", timeoutMs);
}

/** 把一组端点包成 FailoverLlmClient；时钟可注入（冷却到期推进用）。 */
function makePool(range, names, { timeoutMs = 30_000, cooldownMs = 30_000, clock = { now: 0 }, sleepless = true, failFastOnAuth } = {}) {
  const groups = names.map((n) => ({ label: n, clients: [makeEndpoint(range, n, timeoutMs)] }));
  return new FailoverLlmClient(groups, sleepless ? async () => {} : undefined, {
    cooldownMs,
    now: () => clock.now,
    failFastOnAuth,
  });
}

const REQ = { messages: [{ role: "user", content: "ping" }] };

/** 按端点名取健康行（池内键是 `label#0`）。 */
function healthOf(pool, name) {
  return pool.health().find((x) => x.key === `${name}#0`);
}

/* ------------------------------------------------------------------- 用例 */

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function withRange(scripts, fn) {
  const range = await startTargetRange(scripts);
  try {
    return await fn(range);
  } finally {
    await range.close();
  }
}

async function main() {
  /* T1 429 轮换：命中第二条线路，坏线路进冷却，冷却期内不再被撞 */
  await withRange({ a: ["status:429", "status:429"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    const res = await pool.chat(REQ);
    check("T1 429 后轮换到健康线路", res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1);
    await pool.chat(REQ);
    check("T1 冷却期内坏线路被跳过", r.hits("a") === 1 && r.hits("b") === 2);
    const h = healthOf(pool, "a");
    check("T1 坏线路显示冷却中", h.cooling === true && h.remainingMs > 0);
  });

  /* T2 Retry-After 被尊重（429 + retry-after:2 → 冷却 2s，不是默认 30s） */
  await withRange({ a: ["status:429+retryafter:2", "status:429"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    await pool.chat(REQ);
    const h = healthOf(pool, "a");
    check("T2 Retry-After 决定冷却时长", h.remainingMs === 2_000, `remainingMs=${h.remainingMs}`);
    check("T2 命中线路计入限流账", h.rateLimitHits === 1 && h.failures === 1);
  });

  /* T3 认证 fail-fast（单 provider 池默认）：401 直接抛，不轮换 */
  await withRange({ a: ["status:401", "status:401"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock, failFastOnAuth: true });
    let caught = null;
    try {
      await pool.chat(REQ);
    } catch (e) {
      caught = e;
    }
    check(
      "T3 401 fail-fast 抛出且不轮换",
      caught instanceof HttpLlmError && caught.status === 401 && r.hits("b") === 0,
    );
  });

  /* T4 跨 provider 池：401 只 bench 本线路，健康 provider 接上 */
  await withRange({ a: ["status:401", "status:401"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock, failFastOnAuth: false });
    const res = await pool.chat(REQ);
    check("T4 跨池 401 只 bench 本线路", res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1);
  });

  /* T5 线路级永久错误（402/404/410）：bench 本线路并轮换（新语义） */
  for (const code of [402, 404, 410]) {
    await withRange({ a: [`status:${code}`, `status:${code}`], b: ["ok", "ok"] }, async (r) => {
      const clock = { now: 0 };
      const pool = makePool(r, ["a", "b"], { clock });
      const res = await pool.chat(REQ);
      const ok1 = res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1;
      await pool.chat(REQ);
      const ok2 = r.hits("a") === 1 && r.hits("b") === 2; // 冷却期内不再撞
      check(`T5 HTTP ${code} bench 该线路并轮换`, ok1 && ok2, `hits a=${r.hits("a")} b=${r.hits("b")}`);
    });
  }

  /* T6 500 瞬时故障：轮换 + 冷却 */
  await withRange({ a: ["status:500", "status:500"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    const res = await pool.chat(REQ);
    await pool.chat(REQ);
    check("T6 500 轮换且冷却", res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 2);
  });

  /* T7 挂起端点：真超时（AbortSignal.timeout）→ 轮换（timeoutMs 300ms << hang 5s） */
  await withRange({ a: ["hang:5000"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const t0 = Date.now();
    const pool = makePool(r, ["a", "b"], { clock, timeoutMs: 300 });
    const res = await pool.chat(REQ);
    const elapsed = Date.now() - t0;
    check(
      "T7 挂起端点真超时后轮换",
      res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1 && elapsed < 3_000,
      `elapsed=${elapsed}ms`,
    );
    // 超时按 transient 记账 → 该线路进冷却
    const h = healthOf(pool, "a");
    check("T7 超时线路进冷却", h.cooling === true && h.failures === 1);
  });

  /* T8 畸形 HTML 响应：MalformedResponseError → 轮换 */
  await withRange({ a: ["malformed", "malformed"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    const res = await pool.chat(REQ);
    check("T8 畸形响应轮换到健康线路", res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1);
    const h = healthOf(pool, "a");
    check("T8 畸形响应按 transient 记账", h.failures === 1 && h.rateLimitHits === 0);
  });

  /* T9 截断 JSON 响应：同样轮换 */
  await withRange({ a: ["truncate", "truncate"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    const res = await pool.chat(REQ);
    check("T9 截断 JSON 轮换", res.content === "pong" && r.hits("a") === 1 && r.hits("b") === 1);
  });

  /* T10 全池冷却 → AllRoutesCoolingError（带 retryInMs），到期恢复可服务 */
  await withRange({ a: ["status:429", "status:429"], b: ["status:429", "status:429"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    let first = null;
    try {
      await pool.chat(REQ);
    } catch (e) {
      first = e;
    }
    check("T10 全坏时抛原始错误", first instanceof HttpLlmError && first.status === 429);
    let second = null;
    try {
      await pool.chat(REQ);
    } catch (e) {
      second = e;
    }
    check(
      "T10 第二次立刻抛 AllRoutesCoolingError",
      second instanceof AllRoutesCoolingError && second.retryInMs > 0,
      `retryInMs=${second?.retryInMs}`,
    );
    check("T10 冷却期不真发请求", r.hits("a") === 1 && r.hits("b") === 1);
  });

  /* T11 冷却到期恢复：坏一次后好的线路在冷却过期后被重新服务 */
  await withRange({ a: ["status:429", "ok"], b: ["status:429", "status:429"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    try {
      await pool.chat(REQ);
    } catch {
      /* 全池首轮坏：预期 */
    }
    clock.now = 31_000; // 越过 30s 冷却
    const res = await pool.chat(REQ);
    check("T11 冷却到期恢复", res.content === "pong" && r.hits("a") === 2 && r.hits("b") === 1);
  });

  /* T12 连续失败升级冷却（新语义）：200 → 400 → 800ms（cooldownMs=200） */
  await withRange({ a: ["status:500", "status:500", "status:500", "status:500"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a"], { clock, cooldownMs: 200 });
    for (let round = 0; round < 4; round++) {
      try {
        await pool.chat(REQ);
      } catch {
        /* 单线路必抛 */
      }
      const h = healthOf(pool, "a");
      const expected = 200 * 2 ** round; // 200/400/800/1600
      const hit = h.remainingMs === expected;
      check(`T12 第 ${round + 1} 轮失败冷却 ${expected}ms`, hit, `remainingMs=${h.remainingMs}`);
      if (!hit) break;
      clock.now += expected; // 越过本轮冷却，逼下一轮失败
    }
  });

  /* T13 成功清零连续失败账（升级回档） */
  await withRange({ a: ["status:500", "ok", "status:500", "status:500"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a"], { clock, cooldownMs: 200 });
    try {
      await pool.chat(REQ);
    } catch {
      /* 轮1失败 */
    }
    clock.now += 200;
    const res = await pool.chat(REQ); // 轮2成功 → streak 清零
    check("T13 成功恢复", res.content === "pong");
    clock.now += 1_000;
    try {
      await pool.chat(REQ); // 轮3失败：streak 应从 1 起（不是 2）
    } catch {
      /* 预期 */
    }
    const h = healthOf(pool, "a");
    check("T13 成功清零后冷却回档 200ms", h.remainingMs === 200, `remainingMs=${h.remainingMs}`);
  });

  /* T14 取消不冷却不轮换：外部 abort 后原样抛出，健康线路不被误伤 */
  await withRange({ a: ["hang:5000"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock, timeoutMs: 10_000 });
    const ac = new AbortController();
    const p = pool.chat({ ...REQ, signal: ac.signal });
    setTimeout(() => ac.abort(new Error("user cancelled")), 120);
    let err = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    const a = healthOf(pool, "a");
    const b = healthOf(pool, "b");
    check(
      "T14 取消原样抛出且两线路都不进冷却",
      err !== null && a.cooling === false && b.cooling === false && r.hits("b") === 0,
      `hits b=${r.hits("b")}`,
    );
  });

  /* T15 速度画像：有成功画像的快线路在坏线路冷却到期后仍排在前 */
  await withRange({ a: ["status:429", "ok"], b: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a", "b"], { clock });
    await pool.chat(REQ); // a 429 → b 成功（b 记画像）
    await pool.chat(REQ); // a 冷却中 → 直接 b
    clock.now = 31_000; // a 冷却到期
    await pool.chat(REQ); // b 有画像排前 → 仍然先命中 b
    check(
      "T15 画像排序让快线路继续优先",
      r.hits("a") === 1 && r.hits("b") === 3,
      `hits a=${r.hits("a")} b=${r.hits("b")}`,
    );
  });

  /* T16 jsonMode 下传：请求体带 response_format（链路完整性） */
  await withRange({ a: ["ok", "ok"] }, async (r) => {
    const clock = { now: 0 };
    const pool = makePool(r, ["a"], { clock });
    await pool.chat({ ...REQ, jsonMode: true });
    const body = JSON.parse(r.body("a"));
    check(
      "T16 jsonMode 请求体带 response_format",
      body.response_format?.type === "json_object" && body.model === "m-a",
    );
  });

  /* T17 混沌链：429→500→402→挂起→ok，一次调用穿越全部故障形态 */
  await withRange(
    { c1: ["status:429"], c2: ["status:500"], c3: ["status:402"], c4: ["hang:5000"], c5: ["ok"] },
    async (r) => {
      const clock = { now: 0 };
      const pool = makePool(r, ["c1", "c2", "c3", "c4", "c5"], { clock, timeoutMs: 300 });
      const t0 = Date.now();
      const res = await pool.chat(REQ);
      const elapsed = Date.now() - t0;
      check(
        "T17 混沌链一次调用穿越 4 类故障",
        res.content === "pong" && r.hits("c5") === 1 && elapsed < 3_000,
        `elapsed=${elapsed}ms`,
      );
      const coolingAll = ["c1", "c2", "c3", "c4"].every((e) =>
        healthOf(pool, e).cooling,
      );
      check("T17 四条坏线路全部进冷却", coolingAll);
      const h5 = healthOf(pool, "c5");
      check("T17 成功线路零惩罚", h5.cooling === false && h5.failures === 0);
    },
  );

  /* T18 MalformedResponseError 类型契约：畸形响应真的抛这个类型 */
  await withRange({ a: ["malformed"], b: ["ok"] }, async (r) => {
    const clock = { now: 0 };
    const solo = makeEndpoint(r, "a", 5_000);
    let err = null;
    try {
      await solo.chat(REQ);
    } catch (e) {
      err = e;
    }
    check("T18 裸客户端畸形响应抛 MalformedResponseError", err instanceof MalformedResponseError);
    void clock;
  });

  console.log(failures === 0 ? "\n靶场全部通过 ✅" : `\n靶场失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("靶场自身故障（非被测代码失败）:", e);
  process.exit(1);
});
