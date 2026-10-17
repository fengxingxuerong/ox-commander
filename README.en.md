# OxCommander

[![verify](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml/badge.svg)](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Other orchestrators hand you N diffs and ask you to pick one. OxCommander delivers one that already passed the gate.**
>
> The judging logic itself is proven **site by site**: every branch that decides "pass / fail / retry / revert"
> is mutated one at a time and must be caught by a test. Numbers change as the code grows — the current ones
> are recomputed from the source by a gate (`check:doc-claims`), not hand-written.

A **commander agent**: it turns a requirement into a PRD → tasks → zone-exclusive batches, routes them to
executors in parallel (built-in LLM pool / Codex-like CLIs / HTTP-bridged agents), then gates the result on
build + typecheck + test before delivering. Electron desktop app + headless CLI.

<img src="docs/demo.gif" alt="npm run demo: one real delivery — plan, dispatch, gate, delivery receipt, independent re-verification" width="100%">

## Try it in one command (no clone, no build)

```bash
npx oxcommander --help
echo '{"requirement":"...","projectRoot":"."}' | npx oxcommander        # one delivery, JSONL events on stdout
npx oxcommander serve --port=8787                                       # status page + SSE + POST /run
npx oxcommander mcp                                                     # MCP stdio server for agent hosts
npx oxcommander receipt receipt.json --replay                           # re-verify a delivery independently
```

Requires Node >= 20.19 and one executor credential: a SenseNova API key is enough to start
(it ships with its own executor — no Claude/Codex subscription required), or point it at a CLI agent
you already have via an agent manifest.

Zero-credential demo (creates a tiny target project, runs a full delivery with a fake brain, then
independently re-verifies the receipt):

```bash
git clone https://github.com/fengxingxuerong/ox-commander.git && cd ox-commander
npm install && npm run build:headless && npm run demo
```

## How it differs

Most tools in this category isolate agents in **git worktrees** (12 of 15 in our 2026-09 survey; the
2026-10 wave of "ADE" desktop tools continues that). OxCommander runs agents in **one shared worktree,
mutually exclusive by zone** — so two agents can cooperate across a module boundary, and there is one
result to review instead of N.

| | OxCommander | Orca (93k★) | paperclip (92k★) | ruflo (73k★) | superset (15k★) |
| --- | --- | --- | --- | --- | --- |
| Proposition | decompose → parallel → **hard gate** → deliver one | run N CLI agents in one desk | manage an org of AI employees | multi-model swarm framework | desktop IDE for parallel agents |
| Who decomposes | **engine: requirement → PRD → tasks → batches** | you fan out prompts | you build the org chart | workflow self-orchestration | you create workspaces |
| End state | one gated delivery + a receipt | N diffs, you pick | approvals and cost dashboards | task results | you review and merge |
| Executors | **ships its own LLM pool** — no subscription needed | bring your subscription | bring your subscription | bring your subscription | bring your subscription |
| Isolation | zone mutual exclusion (cross-module edits can cooperate) | worktree per agent | n/a | docker / swarm | worktree per workspace |
| Self-proof | **mutation testing, site granularity** — every decision site has an assertion | — | — | — | — |

Two honest gaps: there is **no macOS desktop build** (no signing certificate; unsigned `.app` is
blocked by Gatekeeper, so we ship nothing rather than something broken) — but the `npx oxcommander`
CLI **does** run on macOS (pure Node package, no native deps; a dedicated `cli (macOS)` CI job
builds and smokes it on every push), and the desktop app is **not a terminal
IDE** — no embedded terminal, no per-file diff viewer yet. The CLI/headless surface is where
programmatic control lives (JSONL protocol + MCP server).

## What you get at the end

Every run emits a **delivery receipt**: gate results, per-task accounting, out-of-zone write handling,
token usage — and, crucially, the **commands it ran** plus a **content fingerprint**. Anyone holding
that receipt can re-run those checks in their own environment without trusting us or this repo:

```bash
npx oxcommander receipt receipt.json            # fingerprint only (exit 5 = not replayed, NOT "verified")
npx oxcommander receipt receipt.json --replay   # actually re-runs the checks: 0 reproduced / 2 contradicted / 3 tampered
```

Other tools say "it passed the gate" and you have to take their word for it. Here the receipt carries
its own evidence.

## Surfaces

| Surface | What it's for |
| --- | --- |
| Desktop app | projects / PRD review / board / settings; keys encrypted in the OS keychain; desktop notifications when a run concludes or needs a decision |
| `ox` (npx / CLI) | scriptable one-shot delivery, JSONL events, exit codes 0 / 1 / 2 |
| `ox serve` | long-running HTTP + SSE: status page, `POST /run`, optional schedule (`--every=30m`) |
| `ox mcp` | MCP stdio server — let other agents drive the platform (`ox_status` / `ox_receipt` / `ox_events` / `ox_run` / `ox_control`) |

⚠️ `ox serve` has **no auth and no TLS by default**: use it on localhost, a private network, or over an
SSH tunnel. Set `OX_SERVE_TOKEN` to opt into Bearer checking.

## Safety boundary

- Every agent side effect goes through the sandbox: layered path judgment (traversal / outside-root /
  protected, resolved via realpath), command allowlist + metacharacter interception, deadline + idle
  timeouts, consecutive-failure circuit breaker, loop detection (an agent that keeps printing the same
  line is aborted, not waited on).
- Out-of-zone writes are **rolled back by default** (from a content backup, not `git stash`); other
  policies: quarantine / keep / log-only.
- The sandbox is **not a firewall**: `node` is on the allowlist, so an agent that wants to make HTTP
  calls can. Credential hygiene is scoped env for verification and CLI subprocesses.
- Full JSONL audit trail, size-rotated.
- API keys are stored encrypted via the OS keychain when available, with an explicit plaintext fallback notice.

## Quality gate

`npm run verify` is the single acceptance entry — a chain of static checks, ~2.1k tests, a mutation
round, two builds, and a set of integration smokes including an offline end-to-end that spends no quota.
The strongest claim is the site-granularity mutation audit (run in CI on every push): **every** decision
site is mutated individually and must be killed. Aggregate mutation scores ("100% killed") are weaker
and are reported separately on purpose — they can hide uncovered sites.

Numbers live in [README.md](README.md) (Chinese, authoritative) and are re-derived from the source by
the gate, so this file deliberately doesn't repeat them.

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md) — the repo's own gate culture (one verify
chain, four synchronized doc lists, manually registered mutation targets) is written up there.

## License

[MIT](LICENSE) © 2026 fengxingxuerong.
