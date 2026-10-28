import { MAX_ACCEPTANCE_CHECKS } from "../../shared/acceptance";
import type { AcceptanceCheck } from "../../shared/types";

/**
 * 操作者验收判据的编辑器（B7）—— 设置页与 PRD 确认页共用。
 *
 * 为什么两处共用一份：判据是**同一条**配置，两个入口各写一遍会出现"设置页里
 * 存了 3 条、PRD 页显示 2 条"这种谁也说不清的状态；共用组件让两处永远说的是
 * 同一件事（与后端只有 `settings.acceptanceChecks` 一个来源同向）。
 *
 * 编辑期刻意**不归一化**：命令敲到一半是空串、`expectContains` multiline 里
 * 正在敲回车 —— 每敲一下就跑一遍归一化会把正在编辑的条目直接删掉（用户看到
 * 的是"输入框自己消失了"）。归一化只在保存那一刻做，由调用方拿
 * `normalizeAcceptanceChecks` 判定，失败就把 issues 摆出来、不落盘。
 */
export function AcceptanceEditor({
  checks,
  onChange,
  disabled = false,
}: {
  checks: AcceptanceCheck[];
  onChange: (checks: AcceptanceCheck[]) => void;
  disabled?: boolean;
}) {
  const patch = (i: number, p: Partial<AcceptanceCheck>) =>
    onChange(checks.map((c, j) => (j === i ? { ...c, ...p } : c)));

  const linesOf = (value: string): string[] | undefined => {
    const lines = value
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  };

  return (
    <div className="acceptance-editor">
      {checks.map((check, i) => (
        <div className="edit-list" key={i}>
          <h4>
            判据 {i + 1}
            <button
              className="danger small"
              disabled={disabled}
              onClick={() => onChange(checks.filter((_, j) => j !== i))}
              title={`删除判据 ${i + 1}`}
              aria-label={`删除判据 ${i + 1}`}
            >
              ✕
            </button>
          </h4>
          <div className="form-row">
            <label htmlFor={`acc-title-${i}`}>名称（可选）</label>
            <input
              id={`acc-title-${i}`}
              disabled={disabled}
              value={check.title ?? ""}
              placeholder="CLI 报数"
              onChange={(e) => patch(i, { title: e.target.value === "" ? undefined : e.target.value })}
            />
          </div>
          <div className="form-row">
            <label htmlFor={`acc-cmd-${i}`}>命令</label>
            <input
              id={`acc-cmd-${i}`}
              disabled={disabled}
              value={check.command}
              placeholder="node"
              onChange={(e) => patch(i, { command: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label htmlFor={`acc-args-${i}`}>参数（空格分隔）</label>
            <input
              id={`acc-args-${i}`}
              disabled={disabled}
              value={check.args.join(" ")}
              placeholder="src/cli.js samples/a.csv"
              onChange={(e) => patch(i, { args: e.target.value.split(/\s+/).filter(Boolean) })}
            />
          </div>
          <div className="form-row">
            <label htmlFor={`acc-contains-${i}`}>输出必须包含（每行一条）</label>
            <textarea
              id={`acc-contains-${i}`}
              rows={2}
              disabled={disabled}
              value={(check.expectContains ?? []).join("\n")}
              placeholder={"rows=3\ncols=2"}
              onChange={(e) => patch(i, { expectContains: linesOf(e.target.value) })}
            />
          </div>
          <div className="form-row">
            <label htmlFor={`acc-files-${i}`}>产物必须存在（每行一条，相对项目根）</label>
            <textarea
              id={`acc-files-${i}`}
              rows={2}
              disabled={disabled}
              value={(check.expectFiles ?? []).join("\n")}
              placeholder={"dist/index.js"}
              onChange={(e) => patch(i, { expectFiles: linesOf(e.target.value) })}
            />
          </div>
        </div>
      ))}
      <div className="btn-row">
        <button
          className="small"
          disabled={disabled || checks.length >= MAX_ACCEPTANCE_CHECKS}
          onClick={() => onChange([...checks, { command: "", args: [] }])}
        >
          ＋ 添加验收判据
        </button>
        <span className="muted">
          {checks.length}/{MAX_ACCEPTANCE_CHECKS} 条
        </span>
      </div>
    </div>
  );
}
