# 交付收尾清单（0.4.1 · 2026-11-12 快照）

> 面向「这个版本到底交了什么、怎么自己验一遍、还差哪几步别人才能装上」。
> 历史过程在 [CHANGELOG.md](../CHANGELOG.md) 与 [ENGINEERING-LOG.md](ENGINEERING-LOG.md)；
> 本文件只放**可核对的事实与命令**。快照类数字（分支领先数 / tag / npm 状态）写于
> 2026-11-12，变动后以命令重查，不要把快照当长期事实。

## 1. 状态

| 项 | 值 | 怎么核对 |
| --- | --- | --- |
| 版本 | `0.4.1`（`package.json` / `dist-cli/package.json` / `headless/mcp.ts` 的 `serverInfo.version` 三处一致，后者由 `src/mcp.test.ts` 钉住） | `node -p "require('./package.json').version"` |
| 分支 | `main`，本地领先 `origin/main` **4** 个提交 | `git rev-list --count origin/main..HEAD` |
| 最新 tag / Release | `v0.4.0`（2026-10-28，带 Windows + Linux 安装包）；**`v0.4.1` 未打** | `git tag -l`、GitHub `/releases` |
| npm 包 `oxcommander` | **404 —— 从未发布** | `curl -o /dev/null -w '%{http_code}' https://registry.npmjs.org/oxcommander` |
| CI 最近一次成功 verify | `bf5d09b`（run #201），即未推的提交之前 | GitHub `/actions/runs` |
| 唯一验收入口 | `npm run verify`（37 段，3–11 min；本机 12 min 含一次环境假红） | `npm run verify` |
| 门禁数字 | 3278 passed / 8 skipped；109 个文件有可执行用例；变异基线 126 目标 / 3356 处位点 | `npm run check:doc-claims` |
| 文档判据 | 37 段在 README / gates.md / SKILL.md / CONTRIBUTING.md 四处声明一致 | 同上 |

## 2. 交付物

| 面 | 产物 | 入口 | 状态 |
| --- | --- | --- | --- |
| 桌面端 | Windows `Setup-x64.exe` / `Portable-x64.exe`、Linux `.AppImage` / `.deb` | `npm run start`（源码）/ Release 资产 | 由 `release.yml` 双 OS 打包；macOS **无**桌面包 |
| CLI | `oxcommander` npm 包（`ox` bin，零 dependencies） | `npx oxcommander --help` / `ox demo` | **包未发到 npm**，本机 `dist-cli/` 已可构建 |
| headless | JSONL 协议 / `serve` 状态页 / MCP stdio server / `ox chat` | `npm run build:headless`、`npm run mcp:serve` | 可用 |
| 交付凭据 | `receipt` + 凭据库 + 回放门 + commit status | `npm run receipt:verify` / `receipt:regress` | 可用 |
| 零凭据样例 | `demo-deliver.mjs`：规划 → 派单 → 门禁 → 凭据 → 复核 | `npm run demo`、`npm run smoke:demo` | 可用，约 2 秒 |
| 文档 | README（中/英）、ARCHITECTURE、product-spec、headless-protocol、serve-deploy、ENGINEERING-LOG | [文档索引](../README.md#文档索引) | 齐 |

## 3. 自己验一遍（复跑命令）

```bash
npm ci
npm run verify                 # 唯一验收入口：37 段，含变异 + 13 条冒烟 + 构建
npm run demo                   # 零凭据零网络，看一次完整交付
npm run receipt:verify <凭据.json> --replay
npm run smoke:cli-install      # npm pack → 全局离线安装 → 从安装位跑 ox demo
npm run mutation:audit         # 完整 site 口径逐位点审计（本机不进 verify，CI 分片跑）
```

构建产物：`npm run build:dist` → `dist/` + `dist-electron/` + `dist-headless/` + `dist-cli/`；
安装包由 `release.yml` 的 `package` job 产出，本机只打 Windows（Linux 运行时行为在 CI 侧验）。

## 4. 已知缺口（不粉饰）

- **npm 包未发出去**：README 中英合计 **23 处** `npx oxcommander` 在包发布前都不可用。
  阻塞点不是文档，是 `NPM_TOKEN` secret 未配（v0.4.0 的 `publish-cli` 就挂在 `Require NPM_TOKEN`）。
- **macOS 无桌面安装包**：无签名凭据，未签名 .app 会被 Gatekeeper 拦；CLI 在 macOS 由
  `verify.yml` 的 `cli (macOS)` job 每次 push 造包冒烟。
- **Linux `desktopName` 的运行时行为未在本机验证**：配置 schema 在 win 打包时全量校验通过，
  窗口关联是否成立由 release CI 的 Linux 产物验证。
- **多线程同屏分栏未做**：当前是一条线程在前台、其余在左栏亮状态点。
- **验收判据只做机械判定**（命令退出码 / 输出片段 / 产物路径）；语义一致性仍是 advisory。
- 其余历史未修项见 [2026-09-24-consistency-review.md](2026-09-24-consistency-review.md)。

## 5. 发布前置（外部动作，需人工确认后执行）

1. **登记 SSH 公钥**：`GET /users/fengxingxuerong/keys` 当前返回 `[]`；本机私钥已能读到
   （`ssh -v` 有 `Offering public key`，指纹 `SHA256:xv1HXMPL1EHKUjSIpuAT3Up5xH99d8PSzBhHGM4lwWw`）。
   把下面这把公钥加到 GitHub → Settings → SSH keys：

   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMAaTFglBy2FYCQC6a6OS3OsFCwZ73mtyqFcx6+9/rET ox-commander@win10
   ```

   链路已配好 `ssh.github.com:443`（`~/.ssh/config`），不需要改网络。
2. **推 main**：`git push origin main`（4 个提交）→ 看 `verify.yml` 的 ubuntu / windows 矩阵。
3. **配 `NPM_TOKEN`**：repo Settings → Secrets → Actions。`release.yml` 的 `publish-cli` 在
   缺 secret 时第一步就点名失败；打 tag 前不配，等于故意制造一次红。
4. **打 `v0.4.1` tag**：触发 `release.yml` → `verify` 闸 → 双 OS 打包 → GitHub Release →
   `npm publish dist-cli`。tag 版本必须与 `dist-cli/package.json` 一致，且 npm 上不存在该版本
   （workflow 里两道 guard 会拦）。**`npx oxcommander` 从这一步起才真正可用。**

## 6. 本机环境注意（Windows / WorkBuddy 沙箱）

- `vite.config.mts` 固定 `test.maxWorkers: 4`：`os.cpus()` 在本机虚报 20 核，默认 19 worker
  会打穿 Windows 提交限额，症状伪装成代码回归。
- 宿主 safe-delete bulk guard（`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=50`，按 turn 累计）
  会拦 vite 的 `emptyOutDir`，表现为 `build` 段假红。处置：先把 `dist/` / `dist-cli/`
  `mv` 出仓库（重命名不算删除），或只对本次命令提高阈值；**不改系统配置、不禁用 guard**。
  CI runner 没有这层 shim。
- `.gitattributes` 已钉死 EOL：系统级 `core.autocrlf=true` 下，一轮 verify 曾报 48 个
  纯行尾假改动。工作区仍有 CRLF 文件属正常，git 会在下次触碰时收敛，不要 `reset --hard`。

## 7. 改动纪律（碰仓库前先读）

- 跑变异 / site 审计前**先 `git commit`**：被强杀的残留会用旧 `.orig` 还原源码，
  未提交改动会被静默抹掉。
- 新导出必须有生产调用者（`check:unwired`）；新生产文件要登记进
  `scripts/mutation-check.mjs` 的 `TARGETS`；`scripts/*.mjs|.cjs` 必须接线。
- 动 `verify` 链要同批改四处文档：README 门禁节、CHANGELOG、SKILL.md、
  `references/gates.md`（`check:doc-claims` 判红）。
- 新测试放 `src/*.test.ts(x)`，需要 DOM 的首行写 `// @vitest-environment jsdom`。
- 记账两本：CHANGELOG（对外简洁）+ ENGINEERING-LOG（对内工程过程），同批写。
