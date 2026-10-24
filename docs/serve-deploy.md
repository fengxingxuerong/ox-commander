# serve 的 VPS 常驻部署（C7 · 2026-10-24）

> 解决的场景：**夜里跑、合上笔记本继续看** —— 把 `oxcommander serve` 以 systemd 服务
> 常驻在一台 VPS 上，TLS 入口交给反向代理，本机浏览器/CI/手机访问状态页与 SSE。
> 面向的是"一个人或一个小团队的自托管"，不是多租户 SaaS —— 鉴权是**单个 bearer
> token**，这是有意的取舍（见文末安全模型）。

```
公网 ──TLS──▶ 反向代理（caddy / nginx）──▶ 127.0.0.1:8787 oxcommander-serve
                                             └─ systemd 常驻 · 回环监听 · token 鉴权
```

职责各管一段：**公网暴露与 TLS 是代理的事，业务服务永远只听回环** —— 生成的单元里
`--host=127.0.0.1` 是刻意的默认，改它之前先想清楚为什么不把这件事留给代理。

## 前置

- 一台 Linux VPS（systemd ≥ 235，`StateDirectory` 需要），Node **≥ 20.19**（运行时依赖
  `AbortSignal.any`，缺了 headless 入口会先发 error 事件再说清换哪个版本）。
- 代码就位并构建：

```bash
git clone https://github.com/fengxingxuerong/ox-commander.git /opt/oxcommander
cd /opt/oxcommander && npm ci && npm run build:headless
```

（npm 包形态发布后，这一步可换成 `npm i -g oxcommander` 并把单元里的路径指到全局包。）

## 1. 建专用用户与目录

```bash
useradd --system --home /opt/oxcommander --shell /usr/sbin/nologin oxcommander
chown -R oxcommander:oxcommander /opt/oxcommander
```

## 2. 生成 systemd 单元

```bash
cd /opt/oxcommander
sudo -u oxcommander node scripts/serve-install.mjs --port=8787 \
  > /tmp/oxcommander-serve.service   # 先看一眼输出（判据见脚本头注释）
cp /tmp/oxcommander-serve.service /etc/systemd/system/
systemctl daemon-reload
```

要定时运行就把参数一起给（`--every` 与 `--spec` 必须成对，缺一个生成器当场拒绝）：

```bash
node scripts/serve-install.mjs --every=30m --spec=/etc/oxcommander/nightly.json > /tmp/…
```

生成器固化的判据（`--selftest` 逐条钉住）：

| 判据 | 为什么 |
| --- | --- |
| token 永不进单元文件 | 单元常被拷进 issue/日志；token 只走 `EnvironmentFile` |
| `--host=127.0.0.1` 唯一取值 | 公网暴露是代理的职责；改它必须是人手改单元 |
| `ProtectSystem=strict` + `ReadWritePaths=${STATE_DIRECTORY}` 成对 | 只 strict 不开写路径，定时状态第一次落盘就写崩 |
| `--schedule-state` 落在 `${STATE_DIRECTORY}` | 应用目录在 strict 下不可写 |
| `--every`/`--spec` 成对或都不出现 | 半个定时配置不许静默变成"没配定时" |

## 3. 放 token（环境文件，不是单元）

```bash
install -d -m 700 /etc/oxcommander
printf 'OX_SERVE_TOKEN=%s\n' "$(openssl rand -hex 24)" > /etc/oxcommander/serve.env
chmod 600 /etc/oxcommander/serve.env
chown root:oxcommander /etc/oxcommander/serve.env   # 服务用户读得到，其他人读不到
```

设了 token 之后**每个请求**（含状态页、SSE、`/run`、`/approve`）都要带
`Authorization: Bearer <token>` 或 `?token=<token>`（浏览器 EventSource 加不了头，
`?token=` 就是为它留的）。

## 4. 起服务并验证

```bash
systemctl enable --now oxcommander-serve
journalctl -u oxcommander-serve -f          # 启动日志：真实端口与绑定地址

# 验收（四条全过才算部署完成）：
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
#   → 401（无 token 被拒 —— 这条是 200 就停下来查：token 没生效）
curl -s -H "Authorization: Bearer $(grep -oP '(?<=OX_SERVE_TOKEN=).*' /etc/oxcommander/serve.env)" \
  http://127.0.0.1:8787/ | head -5
#   → 状态页 HTML
curl -sN -H "Authorization: Bearer <token>" http://127.0.0.1:8787/events | head -1
#   → : connected（建连接注释帧，零历史的新实例也会立即出现；跑过 run 后
#     这里起还会按序补齐历史事件）
curl -s -X POST -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
  -d @nightly.json http://127.0.0.1:8787/run -o /dev/null -w '%{http_code}\n'
#   → 202（已在跑则 409 —— 单 run 语义，不是故障）
```

## 5. TLS 入口（反代）

**caddy**（自动签发续期，两行）：

```caddy
ox.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

**nginx**（证书自己解决，certbot 或手动）：

```nginx
server {
  listen 443 ssl http2;
  server_name ox.example.com;
  ssl_certificate     /etc/letsencrypt/live/ox.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ox.example.com/privkey.pem;
  location / { proxy_pass http://127.0.0.1:8787; }
  location /events {                    # SSE：关掉缓冲，超时拉长
    proxy_pass http://127.0.0.1:8787;
    proxy_buffering off;
    proxy_read_timeout 24h;
  }
}
```

公网验证与第 4 步相同，只是把 `127.0.0.1:8787` 换成 `https://ox.example.com`。

## 日常操作

```bash
systemctl restart oxcommander-serve       # 升级代码后：git pull && npm ci && npm run build:headless && 这条
journalctl -u oxcommander-serve --since today
systemctl status oxcommander-serve
```

## 安全模型（读到这里的都该看）

**被保护的**：设 `OX_SERVE_TOKEN` 后所有路由前置校验（含改状态的 `/run`、`/approve`）；
非回环绑定 + 无 token **拒绝启动**（fail-closed，`serve.ts` 的 `exposureProblem`）；
单元层面 `ProtectSystem=strict`/`NoNewPrivileges`/`PrivateTmp` 限制服务写面。

**刻意不做的**（写在这里，别当成遗漏）：

- **不做成登录系统**：单 bearer token、无用户体系、无角色。多租户治理是另一个产品的事。
- **等值比对而非恒时比对**：本机/内网的低价值目标口径（token 是使用方自己生成的随机值），
  真要对抗时序侧信道，先上 mTLS 再谈这个。
- **TLS 不进 serve 进程**：终结 TLS 是反代的生态位，自签一圈证书既难维护又容易配错；
  回环 + 代理是最少活动部件的形态。
- **token 进了 URL（`?token=`）会留在访问日志里**：这是 EventSource 的代价，代理层可以把
  `?token=` 从日志里脱敏，或接受它 —— 状态页与 SSE 是只读面，真正的写操作（`/run`）建议
  始终用 `Authorization` 头。

## 与其它文档的关系

- 协议语义（事件流、409、定时补跑、`/approve`）：[headless-protocol.md](headless-protocol.md) §8
- 鉴权与 fail-closed 的实现与测试：`headless/serve.ts`（`exposureProblem` / `tokenAccepted`）
- 单元生成判据与自检：`scripts/serve-install.mjs`（`npm run serve:unit -- --selftest`）
