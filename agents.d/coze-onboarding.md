# 扣子（Coze）接入指引

> 致：平台操作员。扣子 bot 走**云端 OpenAPI** 接入——桥（`scripts/coze-bridge.mjs`）
> 已就绪，你只需完成下面的 3 步配置。

## 第 1 步：在 coze.cn 创建并发布 bot

1. 登录 coze.cn → 工作空间 → 创建 bot（名称随意，如「扣子工程师」）
2. **人设与回复逻辑**粘贴以下内容：

```
你是「扣子工程师」，OxCommander 多智能体平台的外聘执行者。

你会收到一个编码任务（含接口契约、专属目录 zone、项目根路径）。

硬性规则：
1. 只允许在 zone 目录内创建/修改文件，禁止触碰 node_modules/.git/.env/package.json/ox-scripts。
2. 代码用 CommonJS（module.exports），禁止第三方依赖。
3. description 中的接口签名、行为边界、数据口径是跨智能体合同，逐字遵守；
   未定义的语义（表头/总数口径、缺失值、精度、退出码、输出格式）必须在
   实现前明确并在测试断言中钉住，禁止静默发明口径。
4. 最终回复必须是且仅是一个 JSON 对象（无 markdown 围栏、无解释文字）：
   {"files":[{"path":"zone内相对路径","content":"文件完整内容"}],"summary":"一句话总结"}
```

3. **发布**（发布渠道勾选「API」）

## 第 2 步：生成 PAT 并写入 .env

coze.cn → 个人中心 → 鉴权 → 生成个人访问令牌（PAT，勾选对应 bot 权限）：

```bash
# 项目 .env 追加两行（值向右填）：
COZE_API_TOKEN=pat_你的令牌
COZE_BOT_ID=你的bot_id
```

## 第 3 步：启动桥 + 注册智能体

```bash
node scripts/coze-bridge.mjs   # 监听 127.0.0.1:8932
```

- **运行时注册（推荐）**：OxCommander → 设置 → 智能体池 → 粘贴
  `agents.d/coze-bridge.example.json` 的内容 → 即时生效
- **声明式注册**：复制为 `%APPDATA%\ox-commander\agents.d\coze.json`，重启生效

注册后在智能体池点「🩺 健康检查」显示可达即接入成功。总指挥官会把
`src/coze/**` zone 的任务自动派给它。

## 安全边界（与其他智能体完全一致）

- 每次写盘过 ZoneGuard 独立复核，越权自动回滚
- 冒烟命令过 CommandPolicy 沙箱门
- PAT 只存在于项目 `.env`（gitignore 兜底），绝不入库、绝不回显
- 连续失败 3 次 → 熔断 60s，任务自动改派其他智能体
