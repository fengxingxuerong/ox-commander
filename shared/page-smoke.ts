/**
 * 页面冒烟判据（竞品缺口 C3：浏览器预览 / 端口）。
 *
 * 缺的是什么：此前 dev server 探活只看 **HTTP 状态码**，2xx/3xx 即通过 ——
 * 于是"端口活着、路由可达"钉住了，"页面有没有内容"没有。前端任务的验证
 * 闭环缺这一环：**跑起来 ≠ 页面没白屏**。
 *
 * 能做的与不能做的（这条边界必须写清楚，否则会被当成"做了浏览器验证"）：
 *
 * - **能**：HTTP 正文是现成的，明确的错误页（Vite / webpack / Next / CRA 的
 *   编译失败页、Cannot GET、404）在正文里有稳定标记 —— 这些能**证伪**。
 * - **不能**：不做 DOM 渲染。JS 崩在运行时、或 SPA 壳里什么都没渲染出来，
 *   正文看不出来（index.html 永远是那个壳）。要断言它得上无头浏览器，
 *   那是几十 MB 依赖 + 一个进程模型，**不进验证链**（与 dev-server.ts 里
 *   "不做页面截图 / DOM 断言"同一条决定）。
 *
 * 于是口径是：**只判红明确错误页，空壳不判红、但把"没法确认"说出来**。
 * 宁可放过，不误报 —— 一条误报的门禁会把好交付挡在门外，那比漏判更糟。
 */

/**
 * 只接受本机回环的 HTTP(S) URL。
 *
 * 用途不止预览：dev-server 冒烟会把规划器生成的 URL 交给 fetch（SSRF 面），
 * schema 在这一层就拒绝非回环地址；桌面预览入口复用同一判据，避免两处各写
 * 一份 whitelist 而漂移。
 */
export function isLoopbackHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

/** 页面冒烟的五种判定。 */
export type PageSmokeVerdict =
  /** HTTP 状态码就不在 2xx/3xx —— 探活层也会判死，这里给出同一事实。 */
  | "http-dead"
  /** 正文里是开发服务器 / 框架的明确错误页。 */
  | "error-page"
  /** 正文是 HTML 但没有任何可见文本（SPA 壳也算这一类）。 */
  | "empty"
  /** 不是 HTML（API 根、二进制、重定向到别的内容类型）—— 白屏判据不适用。 */
  | "not-html"
  /** 看起来是个有内容的页面。 */
  | "ok";

export interface PageSmoke {
  verdict: PageSmokeVerdict;
  /** 是否要让这条检查判红（只有明确错误页才红）。 */
  ok: boolean;
  /** 给人看的一句结论；失败时带命中了什么。 */
  detail: string;
}

/**
 * 错误页标记白名单：**宁可放过，不误报**。
 *
 * 每一条都是对应工具真实写进 HTTP 正文的字样（不是我们猜的形态）：
 *   · `Cannot GET` — webpack-dev-server / http-server 的 404 正文
 *   · `Internal Server Error` — Vite 的编译错误 overlay、Express 默认错误页
 *   · `Failed to compile` — Create React App 的编译失败页
 *   · `This page could not be found` — Next.js 的 404 页
 *   · `Runtime Error` / `Unhandled Runtime Error` — Next.js 的运行时错误页
 */
const ERROR_PAGE_MARKS: ReadonlyArray<{ mark: string; label: string }> = [
  { mark: "Cannot GET", label: "webpack/http-server 的 404 页" },
  { mark: "Internal Server Error", label: "Vite / Express 错误页" },
  { mark: "Failed to compile", label: "CRA 编译失败页" },
  { mark: "This page could not be found", label: "Next.js 404 页" },
  { mark: "Unhandled Runtime Error", label: "Next.js 运行时错误页" },
  { mark: "Runtime Error", label: "Next.js 运行时错误页" },
];

/** 正文采样上限：错误页标记都在头部，取前 64KB 足够，也避免大文件全量扫。 */
const BODY_SAMPLE_LIMIT = 64 * 1024;

/** 剥掉脚本/样式/注释/标签后剩下的"可见文本"。 */
function visibleTextOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 判定一个 HTTP 响应是不是"能看的页面"。
 *
 * `contentType` 缺席时按 HTML 处理（dev server 常常不发 Content-Type）。
 */
export function pageSmokeOf(input: {
  status: number;
  contentType?: string;
  body: string;
}): PageSmoke {
  if (input.status < 200 || input.status >= 400) {
    return { verdict: "http-dead", ok: false, detail: `HTTP ${input.status}` };
  }
  const type = (input.contentType ?? "").toLowerCase();
  // JSON / 纯文本 / 二进制端点不是页面 —— 白屏判据不适用，也不该因为它判红。
  if (type !== "" && !type.includes("html") && !type.includes("text/plain")) {
    return { verdict: "not-html", ok: true, detail: `内容类型 ${type}：不是页面，白屏判据不适用` };
  }
  const sample = input.body.slice(0, BODY_SAMPLE_LIMIT);
  for (const { mark, label } of ERROR_PAGE_MARKS) {
    if (sample.includes(mark)) {
      return { verdict: "error-page", ok: false, detail: `正文里是${label}（命中「${mark}」）` };
    }
  }
  const visible = visibleTextOf(sample);
  if (visible === "") {
    return {
      verdict: "empty",
      // 不判红：SPA 的 index.html 本来就是空壳，JS 渲染后才有内容 ——
      // HTTP 正文看不见那一步，所以"空"只说明**没法确认**，不代表交付失败。
      ok: true,
      detail: "首页正文没有可见文本（SPA 壳常见）—— 无法用 HTTP 正文确认渲染结果，需真浏览器才能断言",
    };
  }
  return { verdict: "ok", ok: true, detail: `首页有可见文本（${visible.length} 字符）` };
}
