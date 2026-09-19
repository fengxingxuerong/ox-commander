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
    files: ["src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
