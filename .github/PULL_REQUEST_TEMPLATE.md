## 这个 PR 做了什么

<!-- 一句人话 + 关键点列表。与 issue 的关联（closes #123）写在这里。 -->

## 边界与已知缺口

<!-- 这个改动明确不覆盖什么；故意保留的缺陷写在这里，不要等别人来问。 -->

## 门禁自查

- [ ] 在**干净树**上跑过 `npm run verify` 整链，EXIT 0（PR 描述里附退出码或卡点说明）
- [ ] 若改了 `verify` 链：README 门禁索引节 / CHANGELOG / SKILL.md / `references/gates.md` **四处**已同步
- [ ] 若加了变异目标文件：已在 `scripts/mutation-check.mjs` 的 `TARGETS` 登记
- [ ] 若加了新导出：有生产代码调用者（或已进 `check:unwired` 的 ACCEPTED 并写理由）
- [ ] 若加了新 `scripts/*.mjs|.cjs`：已被可达脚本引用（package.json 或注释提及均算）
- [ ] CHANGELOG.md 已记账（只记对用户/维护者可见的变化，含边界）
- [ ] 新测试放在 `src/*.test.ts(x)`；DOM 用例首行有 `// @vitest-environment jsdom`
