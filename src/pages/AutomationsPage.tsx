import { useApp } from "../store";

/**
 * 「自动化」页（IA-2 导航格 · 诚实占位）。
 *
 * 为什么先摆一个占位而不是等 M5b 一起做：导航格决定产品的**形状**，页面决定
 * 内容。Codex 把 Automations 做成一级公民，我们就不能在它该在的位置上留空 ——
 * 但摆一个假按钮更坏，所以这里写清"引擎有什么、界面还缺什么"。
 *
 * 事实口径（都来自现有代码，不是承诺）：
 * - 时间触发的判定逻辑在 `headless/schedule-core.ts`（`--every` 自投递 POST /run）；
 * - 桌面端此前零入口 —— 引擎有、界面没有；
 * - Codex 的事件触发（issue/告警/CI/PR）我们**不做蓝图承诺**：需要常驻可达性，
 *   价值待验证（见蓝图 §五 可做档）。
 */
export function AutomationsPage() {
  const setPage = useApp((s) => s.setPage);

  return (
    <section className="card">
      <h2>自动化</h2>
      <p className="card-sub">定时触发 · 引擎就绪，桌面入口在建（M5b）</p>
      <p className="muted">
        引擎侧已经有一半：<code>headless/schedule-core.ts</code> 按间隔自投递调度、忙时跳过不积压。
        这一格要做的是把同一份判定逻辑迁到 <code>shared/</code>，桌面与 headless 共用，再加触发历史。
      </p>
      <ul className="muted">
        <li>本轮先做时间触发（引擎现成）；事件触发（webhook）不在蓝图承诺内。</li>
        <li>迁移不改语义：headless 侧原有用例零回归是验收条件之一。</li>
      </ul>
      <div className="btn-row">
        <button type="button" onClick={() => setPage("chat")}>
          回到会话
        </button>
      </div>
    </section>
  );
}
