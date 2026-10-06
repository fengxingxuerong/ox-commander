import { describe, expect, it } from "vitest";
import { buildDecomposePrompt, buildEscalationSummary, CONTRACT_MARKER, STANDARD_CONTRACT_RULES } from "../shared/prompts";
import type { PrdDocument } from "../shared/types";

const PRD: PrdDocument = {
  goal: "CSV 统计工具",
  features: ["解析 CSV", "按列统计"],
  techStack: ["Node.js"],
  acceptanceCriteria: ["node --test 全绿"],
};

describe("buildDecomposePrompt", () => {
  it("要求生成独立样本冒烟清单（防自证盲区层）", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toContain('"smoke"');
    expect(p).toContain("expectContains");
    expect(p).toMatch(/sample data|样例数据/);
  });

  it("冒烟期望片段必须来自样例数据手算，不得抄实现", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/not copied from the implementation/);
  });

  it("冒烟命令同样受沙箱约束（无 shell 元字符/危险程序）", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/shell metacharacters|strict sandbox policy/);
  });

  it("无可运行入口时允许返回空冒烟数组", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/empty "smoke" array/);
  });
});

describe("平台契约模板（STANDARD_CONTRACT_RULES）", () => {
  it("覆盖历史漂移的全部语义维度（表头/空值/精度/错误/输出格式）", () => {
    const rules = STANDARD_CONTRACT_RULES;
    expect(rules).toMatch(/表头\/总数口径/);
    expect(rules).toMatch(/缺失值/);
    expect(rules).toMatch(/四舍五入/);
    expect(rules).toMatch(/退出码/);
    expect(rules).toMatch(/stdout 只输出结果/);
    expect(rules).toMatch(/禁止自由发挥|不得照抄实现/);
  });

  it("含防重复拼接的标记", () => {
    expect(STANDARD_CONTRACT_RULES).toContain("【平台契约条款");
    expect(CONTRACT_MARKER).toBe("[平台契约条款]");
  });

  it("decompose 提示词要求任务描述携带契约条款", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/contract clause list/);
    expect(p).toMatch(/never invent conventions silently/);
  });
});

/**
 * 这段摘要是**人做处置决定时唯一的输入**（跳过 / 重派 / 终止），而它此前一行都没被断过：
 * orchestrator 的用例只数回调次数，不读文案。文案与实际可接受的判定值一旦漂移，
 * 用户会照着提示选一个并不存在的动作。
 */
describe("buildEscalationSummary", () => {
  const base = {
    taskTitle: "CSV 解析模块",
    attemptsSoFar: 5, // 派发总次数 = 首次 1 + 重修 4
    maxRepairRounds: 4,
    lastErrorDigest: "AssertionError: expected 1 to be 2",
  };

  it("点名三个真实可选的处置，并给出两个数字（已试次数与上限）", () => {
    const s = buildEscalationSummary(base);
    for (const verb of ["跳过", "重派", "终止"]) expect(s).toContain(verb);
    expect(s).toContain("CSV 解析模块");
    // 必须钉住「哪个数字是哪个」，不能分开断言 s 含 "5" 与 "4"：
    // 那样即使渲染时把两个字段互换（次数 4 / 上限 5）也依然全绿，
    // 而人正是照这两个数决定"还能不能再试一次"。
    expect(s).toContain("已尝试 5 次（首次 + 重修 4 轮）（已达重修上限 4）");
  });

  it("两个数字来自各自的字段，不是同一处渲染两次", () => {
    // 只改其中一个，另一个不许跟着变 —— 互换字段的回归由此拦住。
    const s = buildEscalationSummary({ ...base, attemptsSoFar: 3 });
    expect(s).toContain("已尝试 3 次（首次 + 重修 2 轮）（还能再重修 2 轮）");
    // 上限变了，次数那半边不许跟着变
    const s2 = buildEscalationSummary({ ...base, maxRepairRounds: 6 });
    expect(s2).toContain("已尝试 5 次（首次 + 重修 4 轮）（还能再重修 2 轮）");
  });

  /**
   * **两个数必须同一个量纲**（2026-10-05 多轮审计）。
   *
   * 缺陷：`attemptsSoFar` 是**派发总次数**（含首次），而 `maxRepairRounds` 是
   * **重修轮数**（不含首次）。旧文案把两者并排印成"重修 N 轮（上限 M）"，
   * 于是真跑出来是：
   *
   *   重修 3 轮（上限 2）    ← 一句不可能成立的话
   *
   * 而用户正是照这两个数判断"还剩没有机会再试一次"。这条分支在 0–1 轮的
   * 测试里永远看不出来（attempts=1、maxRounds=0 → "重修 1 轮（上限 0）"，
   * 读着别扭但不含"超过上限"的荒谬），**必须多轮场景才暴露**。
   */
  it("派发次数与上限不同量纲时，印出来的两个数仍然自洽", () => {
    // ⚠️ `repairs` **允许**大于 `max`：引擎在达到上限的那一轮**仍会再派发一次**
    // 才判定失败（实测 attempts = maxRounds + 2）。所以这里断言的不是
    // "不得超过上限"，而是"**说出来的话得讲得通**"——
    // 旧的"重修 3 轮（上限 2）"讲不通，正是因为它在声称自己还有 1 轮没用。
    for (let attempts = 1; attempts <= 8; attempts++) {
      for (const max of [0, 1, 2, 4]) {
        const s = buildEscalationSummary({ ...base, attemptsSoFar: attempts, maxRepairRounds: max });
        const repairs = attempts - 1;
        // 半句里的两个数必须自洽：重修轮数 = 派发次数 - 1
        expect(s, `attempts=${attempts} max=${max}`).toContain(`已尝试 ${attempts} 次（首次 + 重修 ${repairs} 轮）`);
        // 「已达上限」与「还能再重修 N 轮」必须二选一，且都不许出现 N=0 的废话
        const atLimit = s.includes("已达重修上限");
        const remaining = s.match(/还能再重修 (\d+) 轮/);
        if (repairs >= max) {
          expect(atLimit, `attempts=${attempts} max=${max}`).toBe(true);
          expect(remaining, `attempts=${attempts} max=${max}`).toBeNull();
        } else {
          expect(atLimit, `attempts=${attempts} max=${max}`).toBe(false);
          expect(Number(remaining![1])).toBe(max - repairs);
          expect(Number(remaining![1]), "剩余轮数不该是 0").toBeGreaterThan(0);
        }
      }
    }
  });

  it("旧的那句「重修 N 轮（上限 M）」不许再出现", () => {
    // 回归钉子：这一句的 N 与 M 量纲不同，见上面那条的说明。
    for (const attempts of [1, 2, 3, 5]) {
      const s = buildEscalationSummary({ ...base, attemptsSoFar: attempts, maxRepairRounds: 1 });
      expect(s).not.toMatch(/重修 \d+ 轮（上限 \d+）/);
    }
  });

  it("把最近一次错误原文带上 —— 那是归属线索，不能被摘要吃掉", () => {
    expect(buildEscalationSummary(base)).toContain("AssertionError: expected 1 to be 2");
  });

  it("错误摘要为空时写「(空)」，而不是留一行悬空的标题", () => {
    const s = buildEscalationSummary({ ...base, lastErrorDigest: "" });
    expect(s).toContain("最近一次错误摘要：");
    expect(s).toContain("(空)");
    expect(s.endsWith("(空)")).toBe(false); // 后面还有那句处置提示
  });

  /**
   * 验证全绿时不得说"仍未通过验证"（2026-10-05 运行时观察）。
   *
   * 真实 run 里任务死因是 `no-agent`（调度器没匹配到执行者），项目文件没人动，
   * 基线本来就绿 → 验证**必然**全绿。而弹窗第一行写着"仍未通过验证"，
   * 紧接着第二行是 "no agent available"。用户是照着这三选一做决定的 ——
   * 他会以为是代码坏了去选"重派"，于是又烧一整轮。
   */
  it("验证通过时说「仍未完成」而不是「仍未通过验证」，且明说卡在任务本身", () => {
    const s = buildEscalationSummary({
      ...base,
      lastErrorDigest: "no agent available",
      verificationPassed: true,
    });
    expect(s).not.toContain("仍未通过验证");
    expect(s).toContain("仍未完成");
    // 必须点明"验证是过的"——否则用户还是会误以为要去查验证日志
    expect(s).toContain("验证命令是通过的");
    // 三个处置一个都不能少（这是用户唯一能做的事）
    for (const verb of ["跳过", "重派", "终止"]) expect(s).toContain(verb);
  });

  it("验证红着时仍是「仍未通过验证」（别让新增字段把老路径改口）", () => {
    for (const verificationPassed of [false, undefined]) {
      const s = buildEscalationSummary({ ...base, verificationPassed });
      expect(s).toContain("仍未通过验证");
      expect(s).not.toContain("仍未完成");
    }
  });

  it("摘要与首行不自相矛盾：「验证命令是通过的」与「仍未通过验证」不许同时出现", () => {
    // 这是本组用例真正要守的不变量 —— 两条措辞无论怎么改，都不许同时出现。
    //
    // ⚠️ 别把"仍未完成"也算进来：验证通过时那句"仍未完成"**必然**与
    // "验证命令是通过的"并存（它说的是"东西没做出来"，不是"验证没过"）。
    // 我第一版把它算进冲突集合，于是一条**本来就正确**的输出被判红 ——
    // 那不是抓到了缺陷，是把断言写错了。
    for (const verificationPassed of [true, false, undefined]) {
      for (const digest of ["no agent available", "AssertionError: expected 1 to be 2", ""]) {
        const s = buildEscalationSummary({ ...base, verificationPassed, lastErrorDigest: digest });
        const tag = `verificationPassed=${verificationPassed} digest=${digest}`;
        const saysPassed = s.includes("验证命令是通过的");
        const saysFailed = s.includes("仍未通过验证");
        expect(saysPassed && saysFailed, tag).toBe(false);
        // 三种取值各对应一种说法，不许有第四种
        const kinds = [s.includes("验证命令是通过的"), saysFailed].filter(Boolean).length;
        expect(kinds, `${tag}：应当恰好一种`).toBe(1);
      }
    }
  });
});
