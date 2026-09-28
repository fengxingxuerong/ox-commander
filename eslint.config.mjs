/**
 * Flat ESLint config. Philosophy: the type checker (tsc -b, 3 tsconfigs) owns
 * type-level correctness; ESLint here only guards what tsc cannot see —
 * unused vars, hook rules, accidental `eqeqeq`/debugger leftovers. Keep it
 * thin so `npm run verify` stays the single gate.
 */
import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Node 全局名，手写而非引 `globals` 包：那个包没在 package.json 里声明，
 * 从 config 里 import 它就是在依赖一个幽灵传递依赖（哪天 eslint 换掉它，
 * lint 会红在一个跟代码质量无关的地方）。
 */
const SCRIPT_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  require: "readonly",
  module: "writable",
  exports: "writable",
  global: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  structuredClone: "readonly",
  performance: "readonly",
};

/**
 * 脚本规则：只留能抓真问题的。`no-console` / 退出码相关的规则刻意不开 ——
 * 这些脚本的全部职责就是打印和按退出码判定，开了只会逼人写封装。
 */
const SCRIPT_RULES = {
  "no-undef": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-constant-binary-expression": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-duplicate-imports": "error",
  "no-unreachable": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-useless-assignment": "error",
  // `require-await` 刻意不开：脚本里有一批"长得像 fetch 响应"的 async 门面
  // （`text()` / `json()` / `chat()` 返回 Promise 但不 await 任何东西），
  // 它们要的是形状而不是 await，开了只会逼人塞一句假 await。
};

export default [
  {
    // Build outputs, docs assets and the vendored probe never get linted.
    // `scripts/**` used to be here — see the block at the bottom: the gate code
    // is the one thing `tsc` cannot see, so ESLint is its only semantic layer.
    ignores: [
      "dist/**",
      "dist-electron/**",
      "dist-headless/**",
      "node_modules/**",
      "coverage/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TS owns undefined-variable detection; no-undef would false-positive on
      // ambient globals (window/document/process) it cannot see.
      "no-undef": "off",
      // The LLM/IPC boundary legitimately handles untyped JSON payloads.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    /**
     * 分层红线：`shared/` 是纯逻辑层 —— 不碰 node API、不碰宿主层。
     *
     * 为什么现在才立：这条红线此前只活在注释里（`atomic-file.ts:13` 写着
     * "Not shared with shared/: that directory must stay free of node:fs"），
     * 没有任何机制保证它。注释说服得了人，说不服下一个赶工的改动。
     * 落地时 `shared/**` 对外 import 数为 **0**（全是 `./` 相对引用），
     * 所以这是一条零违规的纯增量规则 —— 它只拦未来，不改现状。
     *
     * 反向验证过：临时在 `shared/` 里 `import fs from "node:fs"` →
     * `npm run lint` 立刻红并点名该文件；删掉即恢复。
     *
     * ⚠️ 故意**没有**给 `headless/**` 加同类规则：`run-spec.ts` 现在经
     * `electron/platform` 拉进 `electron/sandbox`，加了当场就红。那条要先解依赖
     * （或先承认它跨层），不是靠规则硬压下去。
     */
    files: ["shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "fs/promises",
                "path",
                "os",
                "child_process",
                "crypto",
                "url",
                "util",
                "events",
                "stream",
                "net",
                "http",
                "https",
                "assert",
              ],
              message:
                "shared/ 必须是纯逻辑层：它同时被 Electron 主进程、headless CLI 与浏览器侧测试引用，" +
                "一旦引入 node API 就不能再在 vitest 里直接跑。需要 IO 就放在 electron/ 或 headless/，由调用方注入。",
            },
            {
              group: ["electron", "electron/*", "react", "react/*", "react-dom", "react-dom/*", "zustand", "zustand/*"],
              message: "shared/ 不得依赖宿主层（Electron / React / 状态库）：它要比任何宿主活得更久。",
            },
            {
              group: ["../electron/**", "../headless/**", "../src/**"],
              message:
                "shared/ 不得反向依赖上层（electron / headless / src）—— 依赖只能从上往下。" +
                "（同层之间的 ../ 相对引用仍然允许，例如 shared/<子目录>/ 引回 shared/glob。）",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    /**
     * `scripts/**` —— 门禁自己的代码现在有一层语义检查。
     *
     * 为什么值得为它单开一块：这 5.7k 行是 `verify` 的判据本身，而 `tsc` 一行都不看
     * （此前只有 `check:scripts` 的 `node --check`，那是**语法**，不是语义）。也就是说
     * 「门禁会不会把脏工作区读成绿」这件事以前没有任何自动化在守 —— 2026-09-28 那次
     * 活体变异残留把第 9 段砸成 heap OOM，就是这条空档的账单。
     *
     * 规则刻意比 TS 侧松：脚本是一次性 CLI，`no-console` 这类会逼出无意义的封装。
     * 留下的都是能抓真问题的：未定义标识符、赋值不用 / 无用赋值、重复键与重复导入、
     * 不可达代码、空块。
     */
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: SCRIPT_GLOBALS,
    },
    rules: SCRIPT_RULES,
  },
  {
    // `.cjs` 与 `scripts/acceptance/` 下那份 `.js`：CommonJS 形状。
    // 后者 vitest 不收（由 check-tests-collected 的豁免表显式记着），但一样要过语义检查。
    files: ["scripts/**/*.{cjs,js}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: SCRIPT_GLOBALS,
    },
    rules: SCRIPT_RULES,
  },
];
