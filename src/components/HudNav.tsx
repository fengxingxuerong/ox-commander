import { useApp } from "../store";
import type { Page } from "../types";
import type { Stage } from "../../shared/types";

/**
 * HUD 顶栏（2026-10-19）。
 *
 * 为什么要有它：此前四个页面只靠各页里零散的「← 返回 / ⚙️ 设置」互相跳转，
 * 第一次打开时看不出「这台机器有几块、我现在在哪一块」。顶栏把四个模块固定
 * 成常驻导航，每格写清「这一块干什么」，运行态（阶段 / 是否有人在跑）放在
 * 右侧常显 —— 不用翻页面就知道现在卡在哪一步。
 *
 * 刻意的两条边界：
 *   ① **只导航，不改状态**：点tab 只调 `setPage`，不开跑、不取数。看板页自己
 *      有开始/暂停/取消，导航里再放一次会让"哪个按钮是真的"变成猜谜。
 *   ② **文案与页面内的按钮刻意不重名**：界面测试按 `getByRole("button", {name})`
 *      取按钮，导航项若也叫「开始 / 暂停 / 取消」会把断言撞成多选。
 */

/** 阶段的操作员语言。与看板同源（`Record<Stage, …>` 缺键即编译错）。 */
const STAGE_SHORT: Record<Stage, string> = {
  PRD: "需求理解",
  PLANNING: "任务分解",
  DEVELOPMENT: "并行开发",
  VERIFICATION: "硬性验证",
  DELIVERY: "集成交付",
  DONE: "已交付",
};

interface NavItem {
  page: Page;
  icon: string;
  label: string;
  sub: string;
  /**
   * 这一格点亮时还认哪些页（IA-2：编排一格包两步）。
   * 没有它，"进了执行看板"会让顶栏看起来没有选中任何一格。
   */
  also?: readonly Page[];
}

/**
 * 主导航四格（IA-2，方案 A）。
 *
 * 会话是**家**（默认页），编排是"会话之外的另一件事"（两步走），自动化与技能
 * 是当前在建的两个一级公民 —— 先占位、明说在建，不留空也不摆假按钮。
 */
const NAV_ITEMS: NavItem[] = [
  { page: "chat", icon: "⌘", label: "会话", sub: "说一句，它自己动手" },
  { page: "prd-review", icon: "▣", label: "编排", sub: "需求确认 → 执行看板", also: ["board"] },
  { page: "automations", icon: "⟳", label: "自动化", sub: "定时触发（界面在建）" },
  { page: "skills", icon: "✦", label: "技能", sub: "本地技能包（在建）" },
];

/** 常驻入口（右上角）：项目库与设置不再占主导航的格子，但仍要一键可达。 */
const UTILITY_ITEMS: NavItem[] = [
  { page: "projects", icon: "◈", label: "项目库", sub: "登记 / 换根 / 删除" },
  { page: "settings", icon: "⚙", label: "设置", sub: "密钥 / 策略 / 智能体" },
];

export function HudNav() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const stage = useApp((s) => s.stage);
  const projects = useApp((s) => s.projects);
  const escalations = useApp((s) => s.escalations);
  const approvals = useApp((s) => s.approvals);

  // 需要人拍板的数量 = 升级 + 命令审批。非零时右侧状态点转品红 ——
  // "机器在等你"这件事不该只在看板页里才看得见。
  const pending = escalations.filter((e) => !e.resolved).length + approvals.filter((a) => !a.resolved).length;
  const running = stage !== "PRD" && stage !== "DONE";
  const dotClass = pending > 0 ? "hud-dot alert" : running ? "hud-dot live" : "hud-dot good";

  return (
    <header className="hud">
      <div className="hud-brand">
        <span className="hud-logo" aria-hidden="true">
          OX
        </span>
        <span className="hud-brand-text">
          <b>OX COMMANDER</b>
          <span>总指挥智能体</span>
        </span>
      </div>

      <nav className="hud-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active = page === item.page || (item.also ?? []).includes(page);
          return (
            <button
              key={item.page}
              type="button"
              className={`hud-tab${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              title={`${item.label} — ${item.sub}`}
              onClick={() => setPage(item.page)}
            >
              <span className="hud-tab-line">
                <span className="hud-tab-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </span>
              <span className="hud-tab-sub">{item.sub}</span>
            </button>
          );
        })}
      </nav>

      <nav className="hud-utility" aria-label="常驻入口">
        {UTILITY_ITEMS.map((item) => (
          <button
            key={item.page}
            type="button"
            className={`hud-utility-btn${page === item.page ? " active" : ""}`}
            aria-current={page === item.page ? "page" : undefined}
            title={`${item.label} — ${item.sub}`}
            onClick={() => setPage(item.page)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="hud-status">
        <span className={dotClass} aria-hidden="true" />
        <span className="hud-stat">
          <span className="hud-stat-label">STAGE</span>
          <span className="hud-stat-value">{STAGE_SHORT[stage] ?? stage}</span>
        </span>
        <span className="hud-stat">
          <span className="hud-stat-label">PROJECTS</span>
          <span className="hud-stat-value">{projects.length}</span>
        </span>
        <span className="hud-stat">
          <span className="hud-stat-label">待决策</span>
          <span className="hud-stat-value">{pending}</span>
        </span>
      </div>
    </header>
  );
}
