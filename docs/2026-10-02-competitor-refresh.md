# 竞品特性刷新与吸收记录（2026-10-02）

> 调研时点：2026-10-02，项目基线 `b725388`（policy.d 四面收尾）。
> 本轮不是重做 2026-09-29 的全景调研（见 [competitor-research](2026-09-29-competitor-research.md)
> 与 [competitive-landscape-and-roadmap](2026-09-29-competitive-landscape-and-roadmap.md)），
> 而是两件事：① 赛道新动态补记；② 把 2026 年弹性库（LLM resilience）赛道的标准特性
> 逐条对照本项目 LLM 池，吸收真空白。

## 一、赛道新动态（2026 上半年）

| 动态 | 与本项目的关系 |
| --- | --- |
| GitHub Agent HQ（2026-02，Claude/Codex/Copilot 同仓派单）、Copilot CLI `/fleet`（2026-04，任务拆解并行子代理）、Copilot 桌面 App（2026-05 Build，worktree 会话 + Agent Merge） | 大厂入场验证了"多 agent 编排"赛道，但其形态全部是 **BYO 订阅 + worktree 隔离** —— 与本项目"自带执行器 + 共享工作区 zone 互斥"的差异位恰好互补：它们的 README 里 `sandbox`/`verify`/`budget` 命中依然是 0 |
| Agent HQ 的 "Human-in-the-Loop 仲裁层"（同一 issue 派给多家，人挑赢家） | 本项目的对应物是四档仲裁 + 硬门禁：终点是"一份过了门禁的交付"而非"N 份 diff 人挑" —— 定位差异不变 |
| 弹性库赛道成熟（LiteLLM cooldown/fallback、llm-router-fallback 的三态断路器 + backoff、agentguard-llm 的 loop 检测、llm-api-resilience 的 checkpoint recovery） | 这批特性是 LLM 池层的"品类标配"。逐条对照见下节 —— 这是本轮的真空白来源 |

## 二、弹性库标准特性逐条对照（本轮吸收依据）

| 标准特性 | 本项目 2026-10-02 之前 | 判定 | 本轮动作 |
| --- | --- | --- | --- |
| Retry-After 尊重（capped） | ✅ 已有（`parseRetryAfterMs` + 双 cap） | 无空白 | — |
| 429/5xx 轮换 + 冷却表 | ✅ 已有 | 无空白 | — |
| 认证错误 fail-fast / 跨池只 bench | ✅ 已有（`failFastOnAuth` 派生） | 无空白 | — |
| 取消不计线路故障 | ✅ 已有（signal.aborted 原样抛） | 无空白 | — |
| 慢线路画像排序 | ✅ 已有（EWMA 画像，超出竞品） | 优势 | — |
| **线路级永久错误 bench**（402 余额 / 404·410 退役 / 405 / 413） | ❌ 这些 4xx 走"不冷却"分支，每次调用重新撞一遍慢请求才轮到健康线路 | **真空白** | ✅ **已吸收**：`ROUTE_LEVEL_4XX` 集合 bench 本线路；400 保持请求级不冷却（换模型可能就对了） |
| **连续失败升级冷却**（consecutive-failure escalation，LiteLLM cooldown 语义） | ❌ 固定 30s 冷却，持续坏掉的线路每 30s 被重撞一次 | **真空白** | ✅ **已吸收**：streak 指数升级（30s→2ⁿ，cap 10min），成功清零回档；Retry-After 存在时服务端权威优先 |
| 三态断路器（half-open 探测） | 沙箱侧 agent 熔断已有；LLM 池侧刻意不做探测（快线路健康时不周期性探测冷却到期的慢线路，2026-09-27 有用例钉住） | 冲突取舍 | 不吸收（探测语义与画像排序冲突） |
| 幂等键（idempotency key） | 无 | 低价值 | 不吸收（后端 API 普遍不支持，注入头是假担保） |
| backoff 抖动（jitter） | 无 | 低价值 | 不吸收（单客户端进程内，无 thundering herd 场景） |
| loop detection（agent 循环检测） | repair loop 有轮次上限；chatJson 有重试上限 | 部分覆盖 | 暂不单做 |
| checkpoint recovery（断点续跑） | ❌ 即待做清单 P1-3 | 真空白 | 留待 P1-3 专项（工程量大，值得单独一轮） |

## 三、本轮落地

1. **`ROUTE_LEVEL_4XX` 线路级永久错误 bench**（`shared/http-clients.ts`）：402/404/405/410/413
   bench 本线路并轮换；400 保持请求级。动机全部来自真实端点实测史：
   z-ai/glm-5.2 退役 410、SenseNova token plan 耗尽 402、NVIDIA 端点 404。
2. **连续失败升级冷却**：`LineStats.streak` + `COOLDOWN_ESCALATION_CAP_MS`（10min）；
   `LineHealth.consecutiveFailures` 出口给 UI（看板线路健康卡显示"连续坏 N 轮"）。
3. **靶场（`scripts/llm-target-range-it.mjs`，挂 `smoke:target-range` 进 verify）**：
   本地故障注入端点矩阵（node:http 按路径扮演多 provider），18 场景 33 断言走
   **真实 HTTP**（真 fetch / 真 TCP / 真 AbortSignal 超时 / 真 Retry-After 头 / 真截断字节流），
   被测对象是 `dist-headless` 编译产物里的生产 FailoverLlmClient。
4. **agents.d 预设扩容**（竞品清单 5.6 的落地）：aider / goose / qwen-code / gemini-cli
   四个 CLI 预设（标注"未在本机实测，接入前 --help 核对"）。

### 同日补记：清单 5.3 / 5.4 / 5.5 全部收官

- **5.3 赛马**：核实发现已于 2026-09-30 由并行工作完成落库（`e52de2a`，
  `raceRedundancy` 设置 + 调度器赛马组 + 变异清零）—— 待做清单口径滞后，非本轮工作。
- **5.4 dev server 托管**：本轮落地（`SmokeCheck.devServer` + `electron/engine/dev-server.ts`，
  驻留进程 + HTTP 探活 + 树杀收尾 + 退出守卫）。
- **5.5 反向 MCP**：本轮落地（`headless/mcp.ts` / `mcp-main.js`，手写 JSON-RPC over
  stdio 零依赖，五工具如实转述 serve HTTP 面；产物冒烟真 stdio 握手）。

至此 2026-09-29 可吸收清单（5.1–5.6）全部有落点：5.1 ActionGate（d6dcb26）、
5.2 facts/derived（4e7a024+89d08a4）、5.3 赛马（e52de2a）、5.4/5.5（本轮）、
5.6 agents.d（本轮）。剩余大项：P1-3 上下文回溯尾巴、P2-3 审批 UI 面、5.7 PR/CI 折中版（远期）。

## 四、参考链接（本轮新增）

- GitHub Agent HQ：https://github.blog/news-insights/company-news/welcome-home-agents/
- Copilot CLI /fleet：https://github.blog/changelog/2026-04-01-copilot-cli-parallel-task-execution/
- LiteLLM cooldown/fallback：https://docs.litellm.ai/docs/proxy/reliability
- llm-router-fallback（三态断路器 + backoff）：https://www.npmjs.com/package/@reaatech/llm-router-fallback
- agentguard-llm（loop 检测/幂等）：https://github.com/maheshmakvana/agentguard-llm
- llm-api-resilience（checkpoint recovery）：https://wpnews.pro/news/multi-provider-llm-resilience-in-python-without-provider-specific-code
