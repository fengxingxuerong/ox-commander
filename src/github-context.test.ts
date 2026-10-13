import { describe, expect, it } from "vitest";
import {
  clampChars,
  clampLimit,
  clipText,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ITEMS,
  fetchGithubContext,
  githubArgs,
  listGithubIssues,
  MAX_ITEMS_CEILING,
  parseIssue,
  parseIssues,
  parsePrComments,
  renderIssues,
  renderPr,
  renderPrComments,
  REPO_RE,
  viewGithubIssue,
  type GithubContextKind,
} from "../electron/context/github-readonly";

/**
 * 注入式 runner：记录每次调用并按脚本回放（不真 spawn `gh`）。
 * 与 git-export.test.ts 的 fakeRunner 同款 —— 判定核心逐点可审，进程边界只在这里。
 */
function recorder(results: Array<{ code: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let i = 0;
  const run = async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const okJson = (stdout: string) => ({ code: 0, stdout });

describe("github-readonly · 预算收敛（clampLimit / clampChars）", () => {
  it("条数：缺席 / 非安全整数 / 非正 → 默认；超上限 → 上限；合法 → 原值", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_MAX_ITEMS);
    expect(clampLimit(1.5)).toBe(DEFAULT_MAX_ITEMS); // 非整数
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_MAX_ITEMS);
    expect(clampLimit(0)).toBe(DEFAULT_MAX_ITEMS); // 非正
    expect(clampLimit(-3)).toBe(DEFAULT_MAX_ITEMS);
    expect(clampLimit(3)).toBe(3); // 合法取值不被误当缺席
    expect(clampLimit(MAX_ITEMS_CEILING + 10)).toBe(MAX_ITEMS_CEILING); // 收敛到上限，不是放大
    expect(clampLimit(MAX_ITEMS_CEILING)).toBe(MAX_ITEMS_CEILING);
  });

  it("字符：缺席 / 非安全整数 / 非正 → 默认；超 50000 → 上限；合法 → 原值", () => {
    expect(clampChars(undefined)).toBe(DEFAULT_MAX_CHARS);
    expect(clampChars(2.5)).toBe(DEFAULT_MAX_CHARS);
    expect(clampChars(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_CHARS);
    expect(clampChars(0)).toBe(DEFAULT_MAX_CHARS);
    expect(clampChars(-1)).toBe(DEFAULT_MAX_CHARS);
    expect(clampChars(1000)).toBe(1000);
    expect(clampChars(999_999)).toBe(50_000);
  });
});

describe("github-readonly · 仓库名与命令构造（githubArgs）", () => {
  it("REPO_RE：接受 owner/repo；拒绝空格、分号、缺斜杠、越界串", () => {
    expect(REPO_RE.test("owner/repo")).toBe(true);
    expect(REPO_RE.test("a.b-c_d/e.f")).toBe(true);
    expect(REPO_RE.test("bad;rm -rf /")).toBe(false);
    expect(REPO_RE.test("no-slash")).toBe(false);
    expect(REPO_RE.test("nested/with/slash")).toBe(false);
    expect(REPO_RE.test("-leading/repo")).toBe(false);
    expect(REPO_RE.test("")).toBe(false);
  });

  it("非法 repo：直接拒绝（返回 null，不出命令）——调用方忘了校验也出不去", () => {
    expect(githubArgs({ kind: "issues", repo: "bad;rm" })).toBeNull();
    expect(githubArgs({ kind: "issues", repo: "no-slash" })).toBeNull();
  });

  it("issues：repo 与 search 出现才带对应 flag（缺席不产生空参数）", () => {
    expect(githubArgs({ kind: "issues", repo: "owner/repo", limit: 3 })).toEqual([
      "issue",
      "list",
      "--repo",
      "owner/repo",
      "--limit",
      "3",
      "--json",
      "number,title,body,state",
    ]);
    const noRepo = githubArgs({ kind: "issues" });
    expect(noRepo).not.toContain("--repo");
    expect(noRepo).toContain("--limit");
    expect(noRepo).toContain(String(DEFAULT_MAX_ITEMS)); // limit 缺省落到默认
    expect(githubArgs({ kind: "issues", search: "is:open" })).toContain("--search");
    expect(githubArgs({ kind: "issues" })).not.toContain("--search");
  });

  it("pr：合法编号出命令；缺编号 / 0 / 负数一律拒绝", () => {
    expect(githubArgs({ kind: "pr", pr: 7 })).toEqual(["pr", "view", "7", "--json", "number,title,body"]);
    expect(githubArgs({ kind: "pr", pr: 7, repo: "o/r" })).toEqual([
      "pr",
      "view",
      "7",
      "--repo",
      "o/r",
      "--json",
      "number,title,body",
    ]);
    expect(githubArgs({ kind: "pr" })).toBeNull();
    expect(githubArgs({ kind: "pr", pr: 0 })).toBeNull();
    expect(githubArgs({ kind: "pr", pr: -1 })).toBeNull();
    expect(githubArgs({ kind: "pr", pr: 1.5 })).toBeNull();
  });

  it("未知 kind：不被接受（返回 null，靠调用方说清原因）", () => {
    expect(githubArgs({ kind: "nope" as unknown as GithubContextKind })).toBeNull();
  });

  it("pr-comments：repo 在场 → 字面路径；缺席 → gh 的 {owner}/{repo} 占位符（不猜仓库）", () => {
    expect(githubArgs({ kind: "pr-comments", pr: 7, repo: "o/r" })).toEqual([
      "api",
      "--method",
      "GET",
      "repos/o/r/pulls/7/comments",
    ]);
    expect(githubArgs({ kind: "pr-comments", pr: 7 })).toEqual([
      "api",
      "--method",
      "GET",
      "repos/{owner}/{repo}/pulls/7/comments",
    ]);
  });

  it("pr-comments：方法强制 GET（不靠 gh 默认值）；PR 号非法一律拒绝", () => {
    const args = githubArgs({ kind: "pr-comments", pr: 3, repo: "o/r" });
    expect(args).toContain("--method");
    expect(args).toContain("GET");
    expect(githubArgs({ kind: "pr-comments", repo: "o/r" })).toBeNull();
    expect(githubArgs({ kind: "pr-comments", pr: 0, repo: "o/r" })).toBeNull();
    expect(githubArgs({ kind: "pr-comments", pr: -2, repo: "o/r" })).toBeNull();
    expect(githubArgs({ kind: "pr-comments", pr: 2.5, repo: "o/r" })).toBeNull();
  });

  it("pr-comments：非法 repo 同样出不去命令（调用方忘了校验也出不去）", () => {
    expect(githubArgs({ kind: "pr-comments", pr: 7, repo: "bad;rm" })).toBeNull();
    expect(githubArgs({ kind: "pr-comments", pr: 7, repo: "no-slash" })).toBeNull();
  });
});

describe("github-readonly · 解析（parseIssues）", () => {
  it("空串 / 坏 JSON / 非数组 → null（拿不到就说拿不到）", () => {
    expect(parseIssues("")).toBeNull();
    expect(parseIssues("   ")).toBeNull();
    expect(parseIssues("{not json")).toBeNull();
    expect(parseIssues("{}")).toBeNull();
    expect(parseIssues("42")).toBeNull();
  });

  it("数组：缺字段按空处理，number 非数字归 0", () => {
    expect(parseIssues('[{"number":5,"title":"t","body":"b","state":"open"}]')).toEqual([
      { number: 5, title: "t", body: "b", state: "open" },
    ]);
    expect(parseIssues('[{"title":"only-title"}]')).toEqual([{ number: 0, title: "only-title", body: "", state: "" }]);
    expect(parseIssues('[{"number":"not-a-number"}]')).toEqual([{ number: 0, title: "", body: "", state: "" }]);
  });

  it("非对象元素跳过、不中断循环 —— 它后面的合法项必须还在", () => {
    // null 元素：`||` 与 `continue` 的 mutant 会在这里露出来（换成 break 会丢掉后面的项）
    expect(parseIssues('[null,{"number":9,"title":"after"}]')).toEqual([
      { number: 9, title: "after", body: "", state: "" },
    ]);
    // 非 object 的标量同样跳过
    expect(parseIssues('[7,{"number":9}]')).toEqual([{ number: 9, title: "", body: "", state: "" }]);
  });
});

describe("github-readonly · 解析（parsePrComments）", () => {
  const sample = JSON.stringify([
    {
      path: "src/a.ts",
      line: 42,
      side: "RIGHT",
      body: "这里少了一个空值检查",
      user: { login: "reviewer" },
    },
  ]);

  it("空串 / 坏 JSON / 非数组 → null（拿不到就说拿不到）", () => {
    expect(parsePrComments("")).toBeNull();
    expect(parsePrComments("   ")).toBeNull();
    expect(parsePrComments("{not json")).toBeNull();
    expect(parsePrComments("{}")).toBeNull();
    expect(parsePrComments("42")).toBeNull();
    expect(parsePrComments("null")).toBeNull();
  });

  it("空数组 → []（合法空结果：\"没有批注\"不是\"拉取失败\"）", () => {
    expect(parsePrComments("[]")).toEqual([]);
  });

  it("数组：字段归一（user.login 提成 author，CRLF 不动留给渲染层）", () => {
    expect(parsePrComments(sample)).toEqual([
      { path: "src/a.ts", line: 42, side: "RIGHT", author: "reviewer", body: "这里少了一个空值检查" },
    ]);
  });

  it("line 缺席回落到 original_line，再缺席为 0（不编行号）", () => {
    expect(parsePrComments('[{"path":"f","original_line":9,"body":"b"}]')).toEqual([
      { path: "f", line: 9, side: "", author: "", body: "b" },
    ]);
    expect(parsePrComments('[{"path":"f","body":"b"}]')).toEqual([{ path: "f", line: 0, side: "", author: "", body: "b" }]);
  });

  it("user 缺席 / 非对象 → author 空串（不当机）", () => {
    expect(parsePrComments('[{"path":"f","line":1,"body":"b"}]')![0]!.author).toBe("");
    expect(parsePrComments('[{"path":"f","line":1,"body":"b","user":"ghost"}]')![0]!.author).toBe("");
    // `user: null` 是 JSON 的合法值，而 `typeof null === "object"` —— 少了 `user &&`
    // 这一步（变异把 && 换成 || 时）就会去取 `null["login"]` 直接抛错。
    expect(parsePrComments('[{"path":"f","line":1,"body":"b","user":null}]')![0]!.author).toBe("");
  });

  it("非对象元素跳过、不中断循环", () => {
    expect(parsePrComments('[null,{"path":"after","line":2,"body":"b"}]')).toEqual([
      { path: "after", line: 2, side: "", author: "", body: "b" },
    ]);
  });
});

describe("github-readonly · 渲染与裁剪（renderIssues / renderPr / clipText）", () => {
  it("issue 渲染成 `- #N [state] title\\nbody`，CRLF 归一为 LF", () => {
    const { text, truncated } = renderIssues(
      [{ number: 3, title: "标题", body: "第一行\r\n第二行", state: "open" }],
      1000,
    );
    expect(truncated).toBe(false);
    expect(text).toBe("- #3 [open] 标题\n第一行\n第二行");
  });

  it("多条 issue 用空行分隔", () => {
    const { text } = renderIssues(
      [
        { number: 1, title: "A", body: "a", state: "open" },
        { number: 2, title: "B", body: "b", state: "closed" },
      ],
      1000,
    );
    expect(text).toBe("- #1 [open] A\na\n\n- #2 [closed] B\nb");
  });

  it("PR 渲染成 `PR #N: title\\nbody`", () => {
    expect(renderPr({ number: 7, title: "标题", body: "正文" }, 1000)).toEqual({
      text: "PR #7: 标题\n正文",
      truncated: false,
    });
  });

  it("clipText：预算内原样返回；超了在尾部标注省略多少字符（不静默丢）", () => {
    expect(clipText("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(clipText("abcdefghij", 10)).toEqual({ text: "abcdefghij", truncated: false });
    const long = "x".repeat(100);
    const clipped = clipText(long, 50);
    expect(clipped.truncated).toBe(true);
    // keep = max(0, 50-40) = 10 —— 头部保留 10 字符，再补标注
    expect(clipped.text).toBe(`${"x".repeat(10)}\n…（已截断，省略 ${100 - 10} 字符）`);
  });

  it("预算小于 40 时 keep 收敛到 0（不出现负数的 slice）", () => {
    const clipped = clipText("y".repeat(30), 20);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe(`\n…（已截断，省略 30 字符）`);
  });

  it("批注渲染成 `- path:line（side）@author: body`，CRLF 归一为 LF", () => {
    const { text, truncated } = renderPrComments(
      [{ path: "src/a.ts", line: 42, side: "RIGHT", author: "reviewer", body: "第一行\r\n第二行" }],
      1000,
    );
    expect(truncated).toBe(false);
    expect(text).toBe("- src/a.ts:42（RIGHT）@reviewer: 第一行\n第二行");
  });

  it("空批注列表给一句实话（不返回空字符串 —— 那会被引擎当成\"没拿到\"）", () => {
    expect(renderPrComments([], 1000)).toEqual({ text: "（该 PR 没有 diff 行批注）", truncated: false });
  });

  it("多条批注用空行分隔，超出预算如实截断", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      line: i,
      side: "RIGHT",
      author: "r",
      body: "b".repeat(50),
    }));
    const { text, truncated } = renderPrComments(many, 100);
    expect(truncated).toBe(true);
    expect(text).toContain("已截断");
  });
});

describe("github-readonly · fetchGithubContext（注入 runner）", () => {
  it("非法 repo：不 spawn，直接说清原因", async () => {
    const { run, calls } = recorder([]);
    const r = await fetchGithubContext({ kind: "issues", repo: "bad;rm", run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("仓库名不合法");
    expect(calls).toHaveLength(0);
  });

  it("参数不被接受（pr 缺编号）：说清不支持，不猜", async () => {
    const { run, calls } = recorder([]);
    const r = await fetchGithubContext({ kind: "pr", run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不支持的拉取方式");
    expect(calls).toHaveLength(0);
  });

  it("gh 非零退出：ok=false 且原因带上命令与 stderr 尾部", async () => {
    const { run, calls } = recorder([{ code: 1, stderr: "gh: not logged in\nrun gh auth login" }]);
    const r = await fetchGithubContext({ kind: "issues", repo: "o/r", run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("gh issue list 失败");
    expect(r.reason).toContain("not logged in");
    expect(calls).toEqual([{ command: "gh", args: githubArgs({ kind: "issues", repo: "o/r" }) }]);
  });

  it("issues 快乐路径：条数如实计入，非截断时 truncated 字段缺席", async () => {
    const { run } = recorder([okJson('[{"number":1,"title":"A","body":"a","state":"open"}]')]);
    const r = await fetchGithubContext({ kind: "issues", run });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(1);
    expect(r.text).toBe("- #1 [open] A\na");
    expect(r.truncated).toBeUndefined(); // 缺席，不是 false
  });

  it("issues 截断：truncated=true 如实上报", async () => {
    const body = "z".repeat(200);
    const { run } = recorder([okJson(JSON.stringify([{ number: 1, title: "A", body, state: "open" }]))]);
    const r = await fetchGithubContext({ kind: "issues", maxChars: 50, run });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("已截断");
  });

  it("issues 输出解析不了：ok=false 且原因带 stdout 尾部", async () => {
    const { run } = recorder([okJson("not json at all")]);
    const r = await fetchGithubContext({ kind: "issues", run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("解析不了");
  });

  it("pr 快乐路径：标题正文成文，非截断时 truncated 缺席", async () => {
    const { run, calls } = recorder([okJson('{"number":7,"title":"T","body":"B"}')]);
    const r = await fetchGithubContext({ kind: "pr", pr: 7, run });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(1);
    expect(r.text).toBe("PR #7: T\nB");
    expect(r.truncated).toBeUndefined();
    expect(calls).toEqual([{ command: "gh", args: githubArgs({ kind: "pr", pr: 7 }) }]);
  });

  it("pr 截断：truncated=true 如实上报", async () => {
    const body = "z".repeat(200);
    const { run } = recorder([okJson(JSON.stringify({ number: 7, title: "T", body }))]);
    const r = await fetchGithubContext({ kind: "pr", pr: 7, maxChars: 50, run });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("pr 响应缺 number 时回落到请求里的 PR 号（拿不到就不许编成 undefined）", async () => {
    const { run } = recorder([okJson('{"title":"T","body":"B"}')]);
    const r = await fetchGithubContext({ kind: "pr", pr: 42, run });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("PR #42: T");
  });

  it("pr 输出非 JSON：ok=false 且原因带 stdout 尾部", async () => {
    const { run } = recorder([okJson("<html>not json</html>")]);
    const r = await fetchGithubContext({ kind: "pr", pr: 7, run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不是 JSON");
  });

  it("pr 输出是标量（非对象）：ok=false", async () => {
    const { run } = recorder([okJson("123")]);
    const r = await fetchGithubContext({ kind: "pr", pr: 7, run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不是对象");
  });

  it("pr 输出是 null：ok=false（不因 typeof null 而误判成对象）", async () => {
    const { run } = recorder([okJson("null")]);
    const r = await fetchGithubContext({ kind: "pr", pr: 7, run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不是对象");
  });

  it("pr-comments 快乐路径：批注成文、条数如实、命令是白名单那条 GET", async () => {
    const { run, calls } = recorder([
      okJson('[{"path":"src/a.ts","line":42,"side":"RIGHT","body":"意见","user":{"login":"rev"}}]'),
    ]);
    const r = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", run });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(1);
    expect(r.text).toBe("- src/a.ts:42（RIGHT）@rev: 意见");
    expect(r.truncated).toBeUndefined();
    expect(calls).toEqual([
      { command: "gh", args: ["api", "--method", "GET", "repos/o/r/pulls/7/comments"] },
    ]);
  });

  it("pr-comments：空数组是合法空结果（ok=true, items=0，话说\"没有批注\"）", async () => {
    const { run } = recorder([okJson("[]")]);
    const r = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", run });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(0);
    expect(r.text).toBe("（该 PR 没有 diff 行批注）");
  });

  it("pr-comments：gh 非零退出，原因带人话命令名（不是 argv 片段）", async () => {
    const { run } = recorder([{ code: 1, stderr: "gh: not logged in" }]);
    const r = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", run });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("gh api pulls comments 失败");
    expect(r.reason).toContain("not logged in");
  });

  it("pr-comments：输出解析不了（坏 JSON / 非数组）→ ok=false", async () => {
    const bad = recorder([okJson("<html>")]);
    const r1 = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", run: bad.run });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("解析不了");
    const scalar = recorder([okJson("123")]);
    const r2 = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", run: scalar.run });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("解析不了");
  });

  it("pr-comments：超预算截断如实上报", async () => {
    const long = JSON.stringify([{ path: "f", line: 1, side: "RIGHT", body: "z".repeat(300), user: { login: "r" } }]);
    const { run } = recorder([okJson(long)]);
    const r = await fetchGithubContext({ kind: "pr-comments", pr: 7, repo: "o/r", maxChars: 50, run });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
  });
});

/**
 * 摄入半边（2026-10-14）：单条 issue 视图 + 两个结构化出口。
 *
 * 与上下文出口的分工：那边产出**成文文本**（给大脑），这边产出**字段**
 * （给选择器与 spec.issue）。判据重点是"失败不说成空结果"—— 空数组是
 * "没有 issue"，reason 是"没拿到"，两件事不能互相冒充。
 */
describe("github-readonly · 摄入半边（issue 单条 + 结构化出口）", () => {
  it("githubArgs issue：合法 → gh issue view；number 非安全正整数 / repo 非法 → null", () => {
    expect(githubArgs({ kind: "issue", number: 42 })).toEqual([
      "issue",
      "view",
      "42",
      "--json",
      "number,title,body,state",
    ]);
    expect(githubArgs({ kind: "issue", number: 42, repo: "owner/repo" })).toEqual([
      "issue",
      "view",
      "42",
      "--repo",
      "owner/repo",
      "--json",
      "number,title,body,state",
    ]);
    // 守卫与 pr / pr-comments 同族：0 / 负数 / 非整数 / 缺席都拒
    expect(githubArgs({ kind: "issue", number: 0 })).toBeNull();
    expect(githubArgs({ kind: "issue", number: -1 })).toBeNull();
    expect(githubArgs({ kind: "issue", number: 1.5 })).toBeNull();
    expect(githubArgs({ kind: "issue" })).toBeNull();
    expect(githubArgs({ kind: "issue", number: 42, repo: "bad;rm" })).toBeNull();
  });

  it("parseIssue：单对象 → 字段收敛；坏 JSON / 数组 / 标量 / 空 → null", () => {
    expect(parseIssue('{"number":7,"title":"t","body":"b","state":"OPEN"}')).toEqual({
      number: 7,
      title: "t",
      body: "b",
      state: "OPEN",
    });
    expect(parseIssue("not json")).toBeNull();
    expect(parseIssue("[]")).toBeNull(); // 数组不是单对象（与 list 出口分工）
    expect(parseIssue('"str"')).toBeNull();
    expect(parseIssue("null")).toBeNull();
    expect(parseIssue("")).toBeNull();
    // 缺字段按空处理，不抛错 —— 与 parseIssues 同口径
    expect(parseIssue("{}")).toEqual({ number: 0, title: "", body: "", state: "" });
  });

  it("viewGithubIssue：成功回 issue；gh 非零 / 坏输出 → reason", async () => {
    const good = recorder([okJson('{"number":9,"title":"暗色模式","body":"夜间不刺眼","state":"OPEN"}')]);
    const r = await viewGithubIssue({ number: 9, run: good.run });
    expect(r).toEqual({ ok: true, issue: { number: 9, title: "暗色模式", body: "夜间不刺眼", state: "OPEN" } });
    expect(good.calls[0]).toEqual({
      command: "gh",
      args: ["issue", "view", "9", "--json", "number,title,body,state"],
    });

    const failed = recorder([{ code: 1, stderr: "not logged in" }]);
    const r2 = await viewGithubIssue({ number: 9, run: failed.run });
    expect(r2.ok).toBe(false);
    expect(r2.ok === false && r2.reason).toContain("gh issue view 失败");

    const broken = recorder([okJson("nope")]);
    const r3 = await viewGithubIssue({ number: 9, run: broken.run });
    expect(r3.ok).toBe(false);
    expect(r3.ok === false && r3.reason).toContain("解析不了");
  });

  it("viewGithubIssue：repo 非法 → 一个命令都不出（守卫在调用方之前）", async () => {
    const rec = recorder([okJson("{}")]);
    const r = await viewGithubIssue({ number: 1, repo: "bad;rm", run: rec.run });
    expect(r).toMatchObject({ ok: false });
    expect(rec.calls.length).toBe(0);
  });

  it("listGithubIssues：成功回**结构化**列表（不渲染成文本，界面要摆编号/状态）", async () => {
    const rec = recorder([
      okJson(
        '[{"number":1,"title":"a","body":"x","state":"OPEN"},{"number":2,"title":"b","body":"y","state":"CLOSED"}]',
      ),
    ]);
    const r = await listGithubIssues({ run: rec.run });
    expect(r).toEqual({
      ok: true,
      issues: [
        { number: 1, title: "a", body: "x", state: "OPEN" },
        { number: 2, title: "b", body: "y", state: "CLOSED" },
      ],
    });
    expect(rec.calls[0]!.args.slice(0, 2)).toEqual(["issue", "list"]);
  });

  it("listGithubIssues：gh 失败 / 坏 JSON → reason（不返回空列表冒充'没有 issue'）", async () => {
    const failed = recorder([{ code: 128, stderr: "no repo" }]);
    const r1 = await listGithubIssues({ run: failed.run });
    expect(r1).toMatchObject({ ok: false });
    expect(r1.ok === false && r1.reason).toContain("gh issue list 失败");
    const broken = recorder([okJson("<html>")]);
    const r2 = await listGithubIssues({ run: broken.run });
    expect(r2).toMatchObject({ ok: false });
    expect(r2.ok === false && r2.reason).toContain("解析不了");
  });
});
