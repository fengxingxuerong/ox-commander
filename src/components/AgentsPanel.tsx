import { useCallback, useEffect, useState } from "react";
import type { AgentCircuitStats, AgentListResult, AgentSummary } from "../types";

const CIRCUIT_LABELS: Record<AgentCircuitStats["state"], string> = {
  closed: "正常",
  "half-open": "半开（探测中）",
  open: "熔断中",
};

/**
 * Agent pool panel (P2): lists every registered agent with its declared
 * capabilities, lets the operator probe / enable / drain-unregister, and
 * registers new CLI or HTTP-bridge agents by pasting a manifest.
 */
export function AgentsPanel() {
  const [data, setData] = useState<AgentListResult | null>(null);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [circuits, setCircuits] = useState<Record<string, AgentCircuitStats>>({});
  const [probing, setProbing] = useState(false);
  const [manifestText, setManifestText] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([
        window.oxCommander.listAgents(),
        window.oxCommander.getAgentStats(),
      ]);
      setData(list);
      setCircuits(stats.circuits);
    } catch (err) {
      setMessage({ kind: "bad", text: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const probeAll = async () => {
    setProbing(true);
    try {
      setHealth(await window.oxCommander.probeAgents());
    } catch (err) {
      setMessage({ kind: "bad", text: (err as Error).message });
    } finally {
      setProbing(false);
    }
  };

  const toggle = async (agent: AgentSummary) => {
    await window.oxCommander.toggleAgent(agent.id, !agent.enabled);
    await refresh();
  };

  const remove = async (agent: AgentSummary) => {
    setBusy(true);
    try {
      const res = await window.oxCommander.unregisterAgent(agent.id, 5000);
      if (res.ok) {
        const p = res.persisted;
        // 文件被改过而没删时要把原因带上，否则用户以为"注销"已经干净了，
        // 结果重启一看它又回来了。
        const tail = p?.removed ? " · 已删除 agents.d 中的文件" : p?.reason ? ` · ${p.reason}` : "";
        setMessage({
          kind: "ok",
          text: `已注销 ${agent.id}（drain: ${"drained" in res ? res.drained : "-"}）${tail}`,
        });
        await refresh();
      } else {
        setMessage({ kind: "bad", text: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const loadExample = async () => {
    const example = await window.oxCommander.exampleManifest();
    setManifestText(JSON.stringify(example, null, 2));
  };

  const register = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const parsed = JSON.parse(manifestText) as unknown;
      const res = await window.oxCommander.registerAgent(parsed);
      if (res.ok && "id" in res) {
        const base = `已注册 ${res.id}${res.replaced ? "（覆盖原注册）" : ""}`;
        // 落盘失败必须说出来：注册这一轮是真的成了，但"记住了"是假的。
        // 只报"已注册"会让人以为重启后还在，下次开机才发现没了。
        setMessage(
          res.persisted?.ok === false
            ? {
                kind: "bad",
                text: `${base} —— 但没写进 agents.d（${res.persisted.reason ?? "原因未知"}），重启后会丢`,
              }
            : {
                kind: "ok",
                text: `${base}${
                  res.persisted?.path ? ` · 已写入 ${res.persisted.path}，重启后仍在` : ""
                }`,
              },
        );
      } else if (res.ok) {
        setMessage({ kind: "ok", text: "已注册" });
      } else {
        setMessage({ kind: "bad", text: res.error });
      }
      if (res.ok) await refresh();
    } catch (err) {
      setMessage({ kind: "bad", text: `JSON 解析失败：${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>智能体池</h2>
      <p className="muted">
        任务按声明的能力（角色 / 目录范围 / 动作）分派。未声明能力的智能体走原有的轮询分发，
        因此增减智能体不会改变单智能体场景下的行为。
      </p>

      <div className="btn-row">
        <button disabled={probing} onClick={() => void probeAll()}>
          {probing ? "检查中…" : "🩺 健康检查"}
        </button>
        <button onClick={() => void refresh()}>↻ 刷新</button>
      </div>

      {data?.agents.map((a) => (
        <div className="agent-card" key={a.id}>
          <div className="form-row">
            <label>
              {a.displayName}{" "}
              <span className={`stage-chip ${a.enabled ? "chip-ok" : "chip-missing"}`}>
                {a.enabled ? "已启用" : "已停用"}
              </span>{" "}
              {circuits[a.id] && circuits[a.id]!.state !== "closed" && (
                <span className="stage-chip chip-missing">{CIRCUIT_LABELS[circuits[a.id]!.state]}</span>
              )}{" "}
              <span className="muted">
                {a.id} · {a.adapter} · {a.source}
                {a.inferredLegacy ? " · 未声明能力" : ""}
              </span>
            </label>
            <div className="btn-row">
              {health[a.id] !== undefined && (
                <span className={health[a.id] ? "ok-text" : "bad-text"}>
                  {health[a.id] ? "可达" : "不可达"}
                </span>
              )}
              <button className="small" onClick={() => void toggle(a)}>
                {a.enabled ? "停用" : "启用"}
              </button>
              <button className="danger small" disabled={busy} onClick={() => void remove(a)}>
                注销
              </button>
            </div>
          </div>
          {circuits[a.id] && (
            <p className="muted agent-meta">
              熔断：{CIRCUIT_LABELS[circuits[a.id]!.state]} · 成功 {circuits[a.id]!.successes} / 失败{" "}
              {circuits[a.id]!.failures}
              {circuits[a.id]!.successRate !== undefined
                ? ` · 成功率 ${(circuits[a.id]!.successRate! * 100).toFixed(0)}%`
                : ""}
              {circuits[a.id]!.state === "open"
                ? ` · ${Math.ceil(circuits[a.id]!.retryInMs / 1000)}s 后允许探测`
                : ""}
            </p>
          )}
          {!a.inferredLegacy && (
            <p className="muted agent-meta">
              角色：{a.capabilities.roles.join(" / ")} · 目录：{a.capabilities.zoneGlobs.join(" , ")} ·
              动作：{a.capabilities.supports.join(" , ")} · 并发：{a.capabilities.maxConcurrency} ·
              上限：{Math.round(a.limits.runDeadlineMs / 1000)}s / 空闲 {Math.round(a.limits.idleTimeoutMs / 1000)}s
              {a.priority !== 0 ? ` · 优先级 ${a.priority}` : ""}
            </p>
          )}
        </div>
      ))}

      {data && data.agents.length === 0 && <p className="muted">当前没有可用智能体。</p>}

      {data && data.manifestErrors.length > 0 && (
        <div className="manifest-error-box">
          <p className="bad-text">agents.d 中有 {data.manifestErrors.length} 个文件未通过校验：</p>
          <ul className="plain-list">
            {data.manifestErrors.map((e) => (
              <li key={e.file}>
                <code>{e.file}</code>：{e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="edit-list">
        <h4>接入外部智能体</h4>
        <p className="muted">
          CLI 类（Codex / Trae / Claude Code）与 HTTP 桥接类（WorkBuddy）都通过 manifest 声明。
          在这里注册会<strong>同时</strong>把 JSON 写进 <code>{data?.manifestDir ?? "agents.d"}</code>
          （一个 manifest 一个文件），重启后照样加载 —— 不用自己抄。
          也可以手放文件进去；手放的文件被改动过的话，注销时不会删它。
        </p>
        <textarea
          className="manifest-input"
          rows={10}
          placeholder='{"id":"codex-cli","displayName":"Codex CLI","adapter":"cli", ...}'
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
        />
        <div className="btn-row">
          <button onClick={() => void loadExample()}>填入示例</button>
          <button className="primary" disabled={busy || manifestText.trim() === ""} onClick={() => void register()}>
            {busy ? "处理中…" : "注册智能体"}
          </button>
        </div>
      </div>

      {message && <p className={message.kind === "ok" ? "ok-text" : "bad-text"}>{message.text}</p>}
    </section>
  );
}
