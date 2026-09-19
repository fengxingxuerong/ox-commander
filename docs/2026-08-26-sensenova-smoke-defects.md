# OxCommander 冒烟测试缺陷记录（SenseNova 真实 API 接入）

- **日期**：2026-08-26
- **范围**：接入商汤 SenseNova 平台（OpenAI 兼容端点 `https://token.sensenova.cn/v1`）并执行端到端冒烟测试期间发现
- **测试对象**：`deepseek-v4-flash`、`sensenova-6.8-flash-lite`、`glm-5.2` 三个模型 × 「PRD 生成 → 任务分解 → 批次规划」全链路
- **状态**：以下 4 个缺陷均已修复并通过回归验证

## 最终验证结果

| 模型 | PRD | 分解 | 批次规划 |
|---|---|---|---|
| deepseek-v4-flash | ✅ | ✅ 8 任务 | ✅ 5 批次 |
| sensenova-6.8-flash-lite | ✅ | ✅ 10 任务 | ✅ 5 批次 |
| glm-5.2 | ✅ | ✅ 5 任务 | ✅ 4 批次 |

---

## Issue 1：`"type": "module"` 与 Electron 主进程 CommonJS 产物冲突

**严重级别**：高（阻断性，且属潜伏缺陷——不接入真实运行链路不会暴露）

### 症状

脚本以 ESM 方式导入 Electron 侧编译产物时报错：

```
SyntaxError: The requested module '../dist-electron/shared/types.js'
does not provide an export named 'DEFAULT_SETTINGS'
```

检查产物发现全部是 CommonJS 形态（`exports.DEFAULT_SETTINGS = ...`）。

### 根因

[tsconfig.electron.json](../tsconfig.electron.json) 以 `module: commonjs` 编译主进程代码，而 [package.json](../package.json) 声明了 `"type": "module"`。该字段会让 Node/Electron 把所有 `.js` 文件按 ESM 解析——不仅脚本导入失败，**Electron 主进程加载 `dist-electron/electron/main.js` 时同样会崩溃**。此前单测均走 Vitest 转译管线，掩盖了这一冲突。

### 修复

- 移除 package.json 中的 `"type": "module"`
- 渲染层由 Vite 打包成自包含 bundle，不受影响；确需 ESM 的独立脚本改用 `.mjs` 后缀显式声明
- 冒烟脚本通过 `createRequire(import.meta.url)` 加载 CJS 产物

### 教训

「编译能过」≠「产物形态正确」。当仓库同时存在多套构建目标（Vite ESM bundle / tsc CJS 产物）时，模块形态声明必须以**被 Node 直接执行的产物**为准。

---

## Issue 2：LLM HTTP 客户端缺少请求超时与传输层重试

**严重级别**：高（可导致整条流水线永久挂起）

### 症状

glm-5.2 在任务分解阶段挂起超过 4 分钟无响应，编排流程无限阻塞。补加超时后，一次网络抖动/慢响应即让整个编排直接抛错终止。

### 根因

- [http-clients.ts](../shared/http-clients.ts) 的 `postJson` 未设置任何 `AbortSignal`，TCP 挂起时 Promise 永不 settle
- [llm-client.ts](../shared/llm-client.ts) 的 `chatJson` 只对「JSON 解析失败 / schema 校验失败」重试，传输层异常（超时、网络错误）直接冒泡，浪费了本可恢复的调用机会

### 修复

- `BaseHttpLlmClient` 新增 `timeoutMs` 配置（默认 300 秒），`postJson` 统一使用 `AbortSignal.timeout(this.timeoutMs)`
- `chatJson` 将 `client.chat()` 包入 try/catch：传输层错误计入重试次数并把错误摘要注入下一轮对话上下文；重试耗尽后原样抛出

### 回归测试

- `retries on transport errors and recovers`
- `rethrows after transport errors exhaust retries`

---

## Issue 3：推理型模型输出解析失败（三层递进表现）

**严重级别**：高（核心链路不可用）；**涉及模型**：deepseek-v4-flash（推理型）

### 症状（按发现顺序递进）

1. **content 为空**：报 `no JSON found in model output`——模型把答案整体放在 `reasoning_content` 字段，`message.content` 为空字符串
2. **散文混排**：回退读取 `reasoning_content` 后，内容形如「分析如下：{伪JSON} …结论…」，旧的「从第一个 `{` 切到末尾」策略报 `Unexpected number in JSON at position 2`
3. **多 JSON 候选抢答**：改为括号平衡扫描后，输出中的**第一个**合法 JSON 是提示词里回显的示例/PRD 对象，真正的任务列表在后——校验命中错误对象，报 `tasks must be a non-empty array`

### 根因

`extractJson` 的单遍解析假设「输出是纯净 JSON 或前后带少量杂质」，无法应对推理型模型的三个特征：答案字段偏移、思考文本混排、提示词内容回显。

### 修复

- **字段回退**：[http-clients.ts](../shared/http-clients.ts) 中 `OpenAiCompatibleClient` 在 `content` 为空白时回退读取 `message.reasoning_content`
- **括号平衡扫描**：新增 `balancedSlice`，从任意位置截取完整平衡的 `{...}` / `[...]` 块，正确跳过字符串字面量内的括号与转义序列（`\\"` 等）
- **逐候选择优**：重构为 `extractJsonCandidates` 收集输出中**全部**合法 JSON 候选，`chatJson` 对每个候选依次执行 schema 校验，**第一个通过校验者胜出**，彻底解决「回显内容抢先命中」

### 回归测试

- `extracts balanced JSON object embedded in prose`
- `extracts JSON with braces inside string values`
- `picks the candidate that passes schema validation`

---

## Issue 4：任务分解输出形态容错不足 + 提示词约束过弱

**严重级别**：中；**涉及模型**：deepseek-v4-flash

### 症状

模型返回**语法完全合法**的 JSON，但 `tasks` 数组的元素是纯字符串（任务标题）而非任务对象，校验报：

```
schema validation failed: tasks[0] must be an object; tasks[1] must be an object
```

另一轮则返回裸数组 `[...]`，被 `parseTaskList` 的「root must be an object」拒绝。

### 根因

- [schema.ts](../shared/schema.ts) 的 `parseTaskList` 只接受 `{"tasks": [...]}` 包装形态
- [prompts.ts](../shared/prompts.ts) 的分解提示词只列出了六个字段的文字说明，**没有给出完整的对象级示例**，弱模型容易把「任务列表」理解成「标题列表」

### 修复

- `parseTaskList` 兼容裸数组输入（自动包装为 `{ tasks: raw }` 再校验）
- `buildDecomposePrompt` 新增两条硬约束：明确「每个元素必须是包含全部六字段的完整 OBJECT，禁止纯字符串条目」，并附上完整 shape 示例（含依赖关系的两个任务）

### 验证

提示词强化后，deepseek-v4-flash 分解一次通过：8 任务 → 5 批次（`add/list/complete` 三命令同批并行，tests/docs 收尾批）。

### 教训

对齐弱模型/新端点时，「schema 兼容多种合理形态 + 提示词给出精确 shape 示例」应作为默认实践，仅靠字段描述不够。

---

## 附：质量门禁快照（修复后）

- 单元测试：32 通过 / 0 失败（含本次新增 5 个回归测试），冒烟测试默认跳过（需 `OX_SMOKE=1` 点燃）
- 类型检查：渲染端 + Electron 端 `tsc -b` 双绿
- 生产构建：Vite 构建成功（151.24 kB JS / gzip 49.35 kB）
