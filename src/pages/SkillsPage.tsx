import { useApp } from "../store";

/**
 * 「技能」页（IA-2 导航格 · 诚实占位）。
 *
 * 与 Skill 真正的差别写在页面上，而不是藏起来：我们的会话工具目录是**硬编码
 * 六件套**（read/grep/apply_patch/run_command/…），没有任何注入第三方能力的通道；
 * 我们是 MCP **server**（`headless/mcp.ts`）—— 能被集成，不能去集成。M6 做的是
 * 本地 Skills 目录 + 注入通道，M7 才是 MCP client。
 *
 * 占位页的价值：导航格先到位，产品形状先对；内容没就绪就明说，不摆假按钮。
 */
export function SkillsPage() {
  const setPage = useApp((s) => s.setPage);

  return (
    <section className="card">
      <h2>技能</h2>
      <p className="card-sub">本地技能包 + MCP client · 界面在建（M6 / M7）</p>
      <p className="muted">
        当前会话可用的工具是固定的六个，没有注入第三方能力的通道。这一格要落的是两件事：
        本地技能目录（<code>.ox/skills</code>）与 MCP client —— 前者是能力扩展面的地基，
        后者是第三方工具的唯一标准通道。
      </p>
      <ul className="muted">
        <li>插件市场不做（那是生态规模游戏；承接形态是本地目录 + agents.d manifest）。</li>
        <li>我们已是 MCP server，缺的是 client 那一半。</li>
      </ul>
      <div className="btn-row">
        <button type="button" onClick={() => setPage("chat")}>
          回到会话
        </button>
      </div>
    </section>
  );
}
