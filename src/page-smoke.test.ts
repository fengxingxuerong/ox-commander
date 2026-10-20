/**
 * 页面冒烟判据（竞品缺口 C3）：HTTP 正文能证伪什么、证不了什么。
 *
 * 单测钉的是两件事：① 明确错误页必须判红；② 空壳（SPA）**不判红**但要把
 * "没法确认"说出来 —— 误报的门禁比漏判贵，而"HTTP 看不见 JS 渲染"是这条
 * 判据的硬边界（写进 `shared/page-smoke.ts` 顶部，别把它当成浏览器验证）。
 */
import { describe, expect, it, vi } from "vitest";
import { pageSmokeOf, isLoopbackHttpUrl } from "../shared/page-smoke";
import { pageSmokeFor } from "../electron/engine/verifier";

describe("isLoopbackHttpUrl", () => {
  it("只接受本机回环的 http(s)", () => {
    for (const url of [
      "http://127.0.0.1:5173/",
      "https://127.0.0.1/",
      "http://localhost:3000",
      "https://localhost/",
      "http://[::1]:8080/",
    ]) {
      expect(isLoopbackHttpUrl(url), url).toBe(true);
    }
  });

  it("拒绝远端、非 HTTP(S) 与非法 URL", () => {
    for (const url of [
      "https://example.com/",
      "http://192.168.1.10:5173/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not-a-url",
      "",
    ]) {
      expect(isLoopbackHttpUrl(url), url).toBe(false);
    }
  });
});

describe("pageSmokeOf", () => {
  it("HTTP 状态码不在 2xx/3xx ⇒ http-dead 且判红", () => {
    for (const status of [199, 404, 500, 302] as const) {
      const s = pageSmokeOf({ status, body: "<html></html>" });
      if (status === 302) {
        // 3xx 由探活层处理（重定向是 dev server 的正常形态），这里不算死
        expect(s.verdict).not.toBe("http-dead");
        continue;
      }
      expect(s.verdict, `status=${status}`).toBe("http-dead");
      expect(s.ok).toBe(false);
    }
  });

  it("明确错误页判红：Vite / webpack / CRA / Next 各自的正文形态", () => {
    const cases: Array<{ body: string; mark: string; label: string }> = [
      { body: "Cannot GET /index.html", mark: "Cannot GET", label: "webpack/http-server" },
      { body: "<h1>Internal Server Error</h1>", mark: "Internal Server Error", label: "Vite/Express" },
      { body: "Failed to compile.\n./src/App.js", mark: "Failed to compile", label: "CRA" },
      { body: "This page could not be found.", mark: "This page could not be found", label: "Next 404" },
      { body: "Unhandled Runtime Error\nError: x", mark: "Unhandled Runtime Error", label: "Next 运行时" },
    ];
    for (const c of cases) {
      const s = pageSmokeOf({ status: 200, contentType: "text/html", body: c.body });
      expect(s.verdict, c.label).toBe("error-page");
      expect(s.ok, c.label).toBe(false);
      // 说清命中的是哪一条标记（人要靠它判断"这是哪个工具的错误页"）
      expect(s.detail, c.label).toContain(c.mark);
    }
  });

  it("SPA 空壳不判红，但要把「没法确认」说出来", () => {
    const body = `<!DOCTYPE html><html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>`;
    const s = pageSmokeOf({ status: 200, contentType: "text/html", body });
    expect(s.verdict).toBe("empty");
    expect(s.ok).toBe(true); // 不因"看不见"判红
    expect(s.detail).toContain("真浏览器"); // 边界必须写给人看
  });

  it("有可见文本的页面 ⇒ ok", () => {
    const s = pageSmokeOf({
      status: 200,
      contentType: "text/html",
      body: "<html><body><h1>待办事项</h1><p>共 3 条</p></body></html>",
    });
    expect(s.verdict).toBe("ok");
    expect(s.ok).toBe(true);
    expect(s.detail).toContain("可见文本");
  });

  it("只有脚本/注释/样式没有文本的白页也判 empty（不误当 ok）", () => {
    const body = "<!-- built at 2026 --><style>.x{color:red}</style><script>void 0</script>";
    expect(pageSmokeOf({ status: 200, body }).verdict).toBe("empty");
  });

  it("JSON 之类的非页面端点 ⇒ not-html 且不判红（白屏判据不适用）", () => {
    const s = pageSmokeOf({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    expect(s.verdict).toBe("not-html");
    expect(s.ok).toBe(true);
    expect(s.detail).toContain("不是页面");
  });

  it("没有 Content-Type 时按 HTML 处理（dev server 常常不发）", () => {
    expect(pageSmokeOf({ status: 200, body: "<body>hi</body>" }).verdict).toBe("ok");
  });
});

describe("pageSmokeFor（取正文那一层）", () => {
  it("正文读不出来 ⇒ 返回 null（没看见，不编一条「页面正常」）", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    expect(await pageSmokeFor("http://127.0.0.1:5173/", fetchImpl)).toBeNull();
  });

  it("页面冒烟不跟随重定向（dev server 不能把 fetch 带出回环）", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, opts?: RequestInit) => {
      init = opts;
      return {
        status: 200,
        headers: { get: () => "text/html" },
        text: async () => "<h1>hi</h1>",
      };
    }) as unknown as typeof fetch;
    expect((await pageSmokeFor("http://127.0.0.1:5173/", fetchImpl))!.ok).toBe(true);
    expect(init?.redirect).toBe("manual");
  });

  it("取到错误页正文 ⇒ 判红；取到正常页 ⇒ 通过", async () => {
    const err = vi.fn(async () => ({
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "Failed to compile",
    })) as unknown as typeof fetch;
    expect((await pageSmokeFor("http://x/", err))!.ok).toBe(false);

    const ok = vi.fn(async () => ({
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<body><h1>hi</h1></body>",
    })) as unknown as typeof fetch;
    expect((await pageSmokeFor("http://x/", ok))!.ok).toBe(true);
  });

  it("取正文抛异常 ⇒ null（不因为断流判红）", async () => {
    const boom = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(await pageSmokeFor("http://x/", boom)).toBeNull();
  });

  /**
   * 下面两条钉的是 `pageSmokeFor` 里「headers 在不在」那一支（verifier.ts:69-70）。
   * 假件都带 headers 时，把 `typeof … === "function"` 反过来**没有任何可见差别** ——
   * 只有当 Content-Type 真的影响判定（JSON 里带错误页字样）或 headers 缺席时，
   * 这一支才被真正走到。
   */
  it("带 headers 时以 Content-Type 为准：JSON 里的错误页字样不算错误页", async () => {
    const json = vi.fn(async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => '{"error":"Cannot GET /"}',
    })) as unknown as typeof fetch;
    const s = await pageSmokeFor("http://x/", json);
    expect(s).not.toBeNull();
    expect(s!.verdict).toBe("not-html"); // 不是页面，白屏判据不适用
    expect(s!.ok).toBe(true);
  });

  it("响应没有 headers 也照样判 —— 不因为取不到 Content-Type 就当没看见", async () => {
    const bare = vi.fn(async () => ({
      status: 200,
      text: async () => "Failed to compile",
    })) as unknown as typeof fetch;
    const s = await pageSmokeFor("http://x/", bare);
    expect(s).not.toBeNull(); // 判据反了会去读 undefined.get → 被 catch 吞成 null
    expect(s!.verdict).toBe("error-page");
    expect(s!.ok).toBe(false);
  });
});
