import { useApp } from "../store";

/**
 * 编排两步（IA-2）。
 *
 * 需求确认与执行看板此前是顶栏上**两格**，对照 Codex 模版后合并为「编排」一格：
 * 指挥中心的首页是会话，编排是"会话之外的另一件事"，它的两个阶段是**同一件
 * 事的两步**，不是两个并列的模块 —— 分成两格会让人以为要二选一。
 *
 * 为什么放在页面顶部而不是顶栏：这两步**强顺序**（先看 PRD 再看进度），
 * 做成页内步骤条能顺带回答"我现在在第几步"；放顶栏则只是换了个跳转入口。
 *
 * 只导航，不改状态（与 HudNav 同一条纪律）：点"执行看板"不开跑、不改阶段。
 */

const STEPS = [
  { page: "prd-review" as const, label: "需求确认", sub: "看 PRD 再批准" },
  { page: "board" as const, label: "执行看板", sub: "实时进度与干预" },
];

export function OrchestrationSteps() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const stepIndex = STEPS.findIndex((s) => s.page === page);
  const active = stepIndex < 0 ? 0 : stepIndex;

  return (
    <nav className="orch-steps" aria-label="编排步骤">
      {STEPS.map((step, i) => (
        <button
          key={step.page}
          type="button"
          className={`orch-step${page === step.page ? " active" : ""}`}
          aria-current={page === step.page ? "step" : undefined}
          title={`第 ${i + 1} 步 — ${step.sub}`}
          onClick={() => setPage(step.page)}
        >
          <span className="orch-step-index" aria-hidden="true">
            {i + 1}
          </span>
          {step.label}
        </button>
      ))}
      <span className="muted orch-step-hint">第 {active + 1} / {STEPS.length} 步 · 先看需求再看进度</span>
    </nav>
  );
}
