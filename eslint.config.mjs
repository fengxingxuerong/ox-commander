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

export default [
  {
    // Build outputs, docs assets and the vendored probe never get linted.
    ignores: [
      "dist/**",
      "dist-electron/**",
      "dist-headless/**",
      "node_modules/**",
      "coverage/**",
      "docs/**",
      "scripts/**",
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
];
