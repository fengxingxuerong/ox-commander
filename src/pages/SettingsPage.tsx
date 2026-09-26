import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { AgentsPanel } from "../components/AgentsPanel";
import { getProvider, PROVIDER_CATALOG, SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../../shared/providers";
import { DEFAULT_SETTINGS, type ArbitrationMode, type ProjectSettings, type VerificationKind } from "../../shared/types";

const KIND_LABELS: Record<VerificationKind, string> = {
  build: "构建",
  typecheck: "类型检查",
  test: "测试",
  smoke: "独立冒烟",
};

interface KeyStatus {
  envVar: string;
  configured: boolean;
  source: "env" | "store";
}

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const loadSettings = useApp((s) => s.loadSettings);
  const saveSettings = useApp((s) => s.saveSettings);
  const setPage = useApp((s) => s.setPage);
  const settingsError = useApp((s) => s.settingsError);
  const [draft, setDraft] = useState<ProjectSettings>(settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus[]>([]);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [keySecurity, setKeySecurity] = useState<{ encryptedAtRest: boolean; plaintextCount: number } | null>(null);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const refreshKeyStatus = useCallback(async (current: ProjectSettings) => {
    // Every provider in the pool needs a key input, not just the selected one —
    // otherwise a pooled provider can only ever be configured via env vars.
    const ids = [...new Set([current.llmProvider, ...(current.llmPool ?? [])])];
    const vars = [
      ...new Set(
        ids.flatMap((id) => {
          const p = getProvider(id);
          return p.id === "sensenova" ? [...SENSENOVA_KEY_VARS] : p.apiKeyEnvVar ? [p.apiKeyEnvVar] : [];
        }),
      ),
    ];
    if (vars.length === 0) {
      setKeyStatus([]);
      return;
    }
    const [status, security] = await Promise.all([
      window.oxCommander.getKeysStatus(vars),
      window.oxCommander.getKeySecurity(),
    ]);
    setKeyStatus(status);
    setKeySecurity(security);
  }, []);

  // The effect below intentionally re-runs only when the *provider selection*
  // changes, not on every keystroke into the draft. A ref carries the latest
  // draft into the effect without widening the dependency list.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    void refreshKeyStatus(draftRef.current).catch(() => setKeyStatus([]));
  }, [draft.llmProvider, draft.llmPool, refreshKeyStatus]);

  const patch = (p: Partial<ProjectSettings>) => setDraft((d) => ({ ...d, ...p }));

  const setCommand = (kind: VerificationKind, value: string) => {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    const [command, ...args] = parts;
    setDraft((d) => {
      const others = d.verificationCommands.filter((c) => c.kind !== kind);
      return command
        ? { ...d, verificationCommands: [...others, { kind, command, args }] }
        : { ...d, verificationCommands: others };
    });
  };

  const commandFor = (kind: VerificationKind): string => {
    const c = draft.verificationCommands.find((x) => x.kind === kind);
    return c ? [c.command, ...c.args].join(" ") : "";
  };

  const toggleAgent = (id: string) => {
    setDraft((d) => ({
      ...d,
      enabledAgents: d.enabledAgents.includes(id)
        ? d.enabledAgents.filter((x) => x !== id)
        : [...d.enabledAgents, id],
    }));
  };

  const togglePoolMember = (id: string) => {
    setDraft((d) => {
      const pool = d.llmPool ?? [];
      return { ...d, llmPool: pool.includes(id) ? pool.filter((x) => x !== id) : [...pool, id] };
    });
  };

  const handleSaveKeys = async () => {
    const entries = Object.entries(keyInputs)
      .map(([envVar, value]) => ({ envVar, value }))
      .filter((e) => e.value !== "");
    if (entries.length === 0) return;
    await window.oxCommander.saveKeys(entries);
    setKeyInputs({});
    await refreshKeyStatus(draft);
  };

  const clearKey = async (envVar: string) => {
    await window.oxCommander.saveKeys([{ envVar, value: "" }]);
    await refreshKeyStatus(draft);
  };

  const runTestLlm = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const r = await window.oxCommander.testLlm();
      setTestResult(r.ok ? `✅ 连接成功（模型：${r.model}）` : `❌ 失败：${r.error}`);
    } catch (err) {
      setTestResult(`❌ 失败：${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const provider = getProvider(draft.llmProvider);

  return (
    <div className="page">
      <header className="page-header">
        <button onClick={() => setPage("projects")}>← 返回</button>
        <h1>设置</h1>
      </header>

      <section className="card">
        <h2>LLM 提供商</h2>
        <div className="form-row">
          <label htmlFor="llm-provider">提供商</label>
          <select
            id="llm-provider"
            value={draft.llmProvider}
            onChange={(e) => patch({ llmProvider: e.target.value })}
          >
            {PROVIDER_CATALOG.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}（{p.defaultModel}）
              </option>
            ))}
          </select>
        </div>
        {draft.llmProvider === "sensenova" && (
          <p className="muted">
            已启用 429 自动故障转移：每个 API Key 一组，组内轮换{" "}
            {SENSENOVA_MODELS.join(" → ")}。
          </p>
        )}
        <div className="btn-row">
          <button disabled={testing} onClick={() => void runTestLlm()}>
            {testing ? "测试中…" : "🔌 测试连接"}
          </button>
          {testResult && <span className={testResult.startsWith("✅") ? "ok-text" : "bad-text"}>{testResult}</span>}
        </div>
      </section>

      <section className="card">
        <h2>线路池（多 API 同时工作）</h2>
        <p className="muted">
          勾选的提供商共享 <strong>同一张</strong>故障转移表：某条线路 429/401 只冷却它自己，请求立刻落到下一条 ——
          同 key 换模型 → 换 key → 换提供商，全程对调用方透明。
        </p>
        {PROVIDER_CATALOG.map((p) => (
          <label key={p.id} className="agent-toggle">
            <input
              type="checkbox"
              checked={(draft.llmPool ?? []).includes(p.id)}
              onChange={() => togglePoolMember(p.id)}
            />
            {p.displayName}
            <span className="muted"> · {p.defaultModel}</span>
          </label>
        ))}
        <p className="muted">
          商汤 = {SENSENOVA_KEY_VARS.length} 密钥 × {SENSENOVA_MODELS.length} 模型 ={" "}
          <strong>{SENSENOVA_KEY_VARS.length * SENSENOVA_MODELS.length} 条线路</strong>
          （{SENSENOVA_MODELS.join(" / ")}）；AMD 端点兜底（实测提供 DeepSeek-V4-Flash 等多个模型）。
          全部取消勾选则退回单一提供商模式。
        </p>
      </section>

      <section className="card">
        <h2>API Keys</h2>
        {provider.id === "ollama" && <p className="muted">Ollama 为本地服务，无需密钥。</p>}
        {keyStatus.map((k) => (
          <div className="form-row key-row" key={k.envVar}>
            <label htmlFor={`key-${k.envVar}`}>
              {k.envVar}{" "}
              <span className={`stage-chip ${k.configured ? "chip-ok" : "chip-missing"}`}>
                {k.configured ? (k.source === "env" ? "环境变量" : "已保存") : "未配置"}
              </span>
            </label>
            <div className="edit-row">
              <input
                id={`key-${k.envVar}`}
                type="password"
                placeholder={k.configured ? "••••••••（输入新值覆盖，留空不变）" : "粘贴 API Key"}
                value={keyInputs[k.envVar] ?? ""}
                onChange={(e) => setKeyInputs((m) => ({ ...m, [k.envVar]: e.target.value }))}
              />
              {k.configured && k.source === "store" && (
                <button className="danger small" title="清除已保存的密钥" onClick={() => void clearKey(k.envVar)}>
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
        {Object.keys(keyInputs).some((v) => keyInputs[v] !== "") && (
          <button className="primary" onClick={() => void handleSaveKeys()}>
            保存密钥
          </button>
        )}
        <p className="muted">
          密钥保存在应用数据目录（keys.json），不会进入代码仓库。
          {keySecurity?.encryptedAtRest
            ? " 已通过系统钥匙串加密存储。"
            : " 当前系统钥匙串不可用，密钥以明文保存，请自行限制文件权限。"}
          {keySecurity && keySecurity.plaintextCount > 0 && keySecurity.encryptedAtRest
            ? ` 其中 ${keySecurity.plaintextCount} 条为旧版明文，重新保存后会自动加密。`
            : ""}
        </p>
      </section>

      <section className="card">
        <h2>硬性验证命令</h2>
        <p className="muted">留空表示跳过该项检查。</p>
        {(Object.keys(KIND_LABELS) as VerificationKind[]).map((kind) => (
          <div className="form-row" key={kind}>
            <label htmlFor={`cmd-${kind}`}>{KIND_LABELS[kind]}</label>
            <input
              id={`cmd-${kind}`}
              value={commandFor(kind)}
              onChange={(e) => setCommand(kind, e.target.value)}
              placeholder="npm run build"
            />
          </div>
        ))}
      </section>

      <section className="card">
        <h2>执行策略</h2>
        <div className="form-row">
          <label htmlFor="max-repair">最大重修轮数</label>
          <input
            id="max-repair"
            type="number"
            min={0}
            max={10}
            value={draft.maxRepairRounds}
            onChange={(e) =>
              patch({ maxRepairRounds: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })
            }
          />
        </div>
        <div className="form-row">
          <span>启用的智能体</span>
          <div className="btn-row">
            {["sensenova-api"].map((id) => (
              <label key={id} className="agent-toggle">
                <input
                  type="checkbox"
                  checked={draft.enabledAgents.includes(id)}
                  onChange={() => toggleAgent(id)}
                />
                {id}
              </label>
            ))}
          </div>
          <p className="muted">
            SenseNova API 执行器：{SENSENOVA_KEY_VARS.length} 组密钥 × {SENSENOVA_MODELS.length} 个模型自动故障转移
            （429/5xx/超时自动切换）。
          </p>
        </div>
        <div className="form-row">
          <label htmlFor="agent-router">
            <input
              id="agent-router"
              type="checkbox"
              checked={draft.agentRouter !== false}
              onChange={(e) => patch({ agentRouter: e.target.checked })}
            />
            {" "}按能力分派任务（关闭后回到轮询分发）
          </label>
        </div>
        <div className="form-row">
          <label htmlFor="max-parallel">并行上限</label>
          <input
            id="max-parallel"
            type="number"
            min={0}
            max={32}
            value={draft.maxParallelRuns}
            onChange={(e) =>
              patch({ maxParallelRuns: Math.max(0, Math.min(32, Number(e.target.value) || 0)) })
            }
          />
        </div>
        <p className="muted">
          同时运行的智能体数量上限（0 表示不限）。批内 zone 互斥只保证"不同目录可以并行"，
          这个上限防止一个大批次把 API 配额打成 429。
        </p>
        <div className="form-row">
          <label htmlFor="max-tokens-per-run">Token 预算上限</label>
          <input
            id="max-tokens-per-run"
            type="number"
            min={0}
            value={draft.maxTokensPerRun ?? 0}
            onChange={(e) =>
              patch({ maxTokensPerRun: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
            }
          />
        </div>
        <p className="muted">
          本次运行累计 token 的软上限（0 表示不限）。达到上限后下一次 LLM 调用在发出前被拒，
          已发生的那一次照常记录 —— 总量始终能和服务商账单对上。
        </p>
        <div className="form-row">
          <label htmlFor="run-wall-clock">单次运行墙钟上限（分钟）</label>
          <input
            id="run-wall-clock"
            type="number"
            min={0}
            value={Math.round((draft.runWallClockMs ?? 0) / 60000)}
            onChange={(e) => {
              const min = Math.max(0, Math.floor(Number(e.target.value) || 0));
              // 界面按分钟给（毫秒没人填得对），存的是毫秒；0 存成 undefined = 不限，
              // 与引擎那边的契约一致（省略字段表示不限，不是"立刻超时"）。
              patch({ runWallClockMs: min > 0 ? min * 60000 : undefined });
            }}
          />
        </div>
        <p className="muted">
          一次运行允许的最长墙钟时间（0 表示不限）。只在批次/重修轮的边界上生效，
          不会掐断已经在途的请求 —— 到点停下并保留现场，可以断点续跑。
          它管的是"这一单跑飞了多久"，与各智能体自己的空闲/总时限是两回事。
        </p>
        <div className="form-row">
          <label htmlFor="brain-timeout">大脑层单次调用超时（秒）</label>
          <input
            id="brain-timeout"
            type="number"
            min={0}
            value={Math.round((draft.brainTimeoutMs ?? 0) / 1000)}
            onChange={(e) => {
              const sec = Math.max(0, Math.floor(Number(e.target.value) || 0));
              // 界面按秒给（毫秒没人填得对），存的是毫秒；0 存成 undefined = 用内置默认，
              // 与 runWallClockMs 同风格（省略字段表示默认）。
              patch({ brainTimeoutMs: sec > 0 ? sec * 1000 : undefined });
            }}
          />
        </div>
        <p className="muted">
          大脑层（PRD / 任务分解）一次 LLM 调用最多等多久。0 表示用内置默认（300 秒）。
          它管的是<strong>单次 HTTP 调用</strong>，与上面的墙钟上限、token 预算是三件不同的事：
          墙钟到点会停下并保留现场，而这个超时只掐掉卡住的那一次请求，线路轮换会接着试下一条。
        </p>
        <div className="form-row">
          <label htmlFor="arbitration">zone 越权处置</label>
          <select
            id="arbitration"
            value={draft.arbitration}
            onChange={(e) => patch({ arbitration: e.target.value as ArbitrationMode })}
          >
            <option value="revert-batch">回滚越权改动（默认，最安全）</option>
            <option value="quarantine">移入隔离区（保留现场证据）</option>
            <option value="deny-all">保留文件但判失败</option>
            <option value="report-only">仅记录日志</option>
          </select>
        </div>
        <p className="muted">
          智能体只应改动自己 zone 内的文件；越权改动默认会被回滚（内容备份在应用数据目录，不使用 git stash/checkout）。
        </p>
      </section>

      <AgentsPanel />

      <section className="card">
        {settingsError && (
          <p className="inline-error" role="alert">
            {/* A failed load leaves `settings` undefined and the save button
                disabled — saying "保存失败" there would send the operator
                hunting for a write that never happened. */}
            {settings ? "保存失败" : "读取失败"}：{settingsError}
          </p>
        )}
        <button
          className="primary"
          disabled={saving || !settings}
          onClick={() => void handleSave()}
        >
          {saving ? "保存中…" : "保存设置"}
        </button>
      </section>
    </div>
  );

  async function handleSave() {
    setSaving(true);
    try {
      await saveSettings(draft);
      // The store records failures instead of throwing, so navigate only when
      // the write actually landed — otherwise a failed save looks successful.
      if (!useApp.getState().settingsError) setPage("projects");
    } finally {
      setSaving(false);
    }
  }
}
