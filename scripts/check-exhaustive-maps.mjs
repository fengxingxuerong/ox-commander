/**
 * 门禁：查「以联合类型为键的映射表 / 穷尽 switch」是否真的把每一档都登记了。
 *
 * 为什么需要它（2026-10-05 并档全表审计第十九轮，人手查出来的）：
 *
 *   · `ERROR_CLASS_LABEL: Record<…errorClass, string>` —— 新增一个 errorClass 忘了加标签，
 *     类型是 `Record<Union, string>` 时 **tsc 会兜住**（缺键编译错）；
 *   · 但 `remedyFor(mode: ArbitrationMode)` 是 **switch + default**：
 *     新增一个仲裁模式它会**静默落到 `default` 的 "fail-batch"`** ——
 *     tsc 不报错、变异门禁看不出来（那条分支活着）、单测也不红。
 *     `default` 恰恰是掩盖点：**"没覆盖"被写成了"覆盖其余一切"。**
 *
 * 所以本门禁只盯 tsc 兜不住的那一半：
 *
 *   1. **映射表**（对象字面量 + `Record<Union, …>` 标注）：键集合 ≠ 联合成员集合 ⇒ 报。
 *      （键多出来也算：说明表里有个成员在类型里已经不存在了。）
 *   2. **穷尽 switch**：`case` 字面量没盖住全部联合成员 ⇒ 报；
 *      有 `default` 时额外标一行「被 default 吞掉」—— 那不是免责，是掩盖。
 *
 * 口径（刻意保守，宁可少报不可错报）：
 *   - 联合类型**含非字符串字面量成员**（如 `string`、`undefined`、对象）⇒ 整体跳过，
 *     不做"部分判定"；跳过的在 `--list` 里列出来，不静默（2026-10-06 首跑：20 处）。
 *   - 只查非测试文件（测试里的表不对外承诺）。
 *   - 同一个文件被多个 tsconfig 包含时（本项目 `electron/` 就同时进了两份），
 *     按 `文件:行:表达式` 去重，不重复计。
 *
 * ⚠️ 它管的是**登记**，不是**行为**：把 `case "deny-all"` 写出来与让它掉进 default
 * 运行时完全等价（所以任何单测都不会变红）。想证明它有效只能靠 `--selftest`
 * 造的 fixture 与下面这句反向注入：**删掉一个 case ⇒ 本门禁红**。
 *
 * 用法：node scripts/check-exhaustive-maps.mjs            （有未登记项时 exit 1）
 *       node scripts/check-exhaustive-maps.mjs --list     （打印全部发现与跳过项）
 *       node scripts/check-exhaustive-maps.mjs --selftest （用临时 fixture 自检判据）
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGS = ["tsconfig.json", "tsconfig.electron.json", "tsconfig.headless.json"];
const LIST = process.argv.includes("--list");
const TEST_FILE = /(\.test\.|\.spec\.|__fakes__|__tests__)/;

/** 取字符串字面量联合的成员；含非字面量成员时返回 null（= 不判）。 */
function literalUnionMembers(checker, type) {
  if (!type || !type.isUnion()) return null;
  const out = [];
  for (const part of type.types) {
    if (!(part.flags & ts.TypeFlags.StringLiteral)) return null;
    out.push(part.value);
  }
  return out.length > 1 ? out : null;
}

function objectLiteralKeys(lit) {
  const keys = [];
  for (const prop of lit.properties) {
    if (!prop.name) continue;
    keys.push(
      ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
        ? prop.name.text
        : prop.name.getText(),
    );
  }
  return keys;
}

function caseLiterals(switchNode) {
  const lits = [];
  for (const clause of switchNode.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const e = clause.expression;
    if (ts.isStringLiteral(e) || ts.isNumericLiteral(e)) lits.push(e.text);
  }
  return lits;
}

/** 扫一组源文件，返回 {tables, switches, skipped}；switches 按 文件:行 去重。 */
function scanFiles(rootNames, options, root) {
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const tables = [];
  const switches = new Map();
  let skipped = 0;

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || TEST_FILE.test(sf.fileName)) continue;
    const rel = path.relative(root, sf.fileName).replace(/\\/g, "/");

    const visit = (node) => {
      // (1) 映射表：const X: Record<Union, …> = { … }
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        node.initializer &&
        ts.isTypeReferenceNode(node.type) &&
        node.type.typeName &&
        node.type.typeName.getText() === "Record" &&
        node.type.typeArguments &&
        node.type.typeArguments.length === 2 &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const keyType = checker.getTypeFromTypeNode(node.type.typeArguments[0]);
        const members = literalUnionMembers(checker, keyType);
        if (!members) skipped++;
        else {
          const keys = objectLiteralKeys(node.initializer);
          const missing = members.filter((m) => !keys.includes(m));
          const extra = keys.filter((k) => !members.includes(k));
          if (missing.length || extra.length) {
            tables.push({ rel, name: node.name.getText(), missing, extra });
          }
        }
      }

      // (2) 穷尽 switch
      if (ts.isSwitchStatement(node)) {
        const members = literalUnionMembers(checker, checker.getTypeAtLocation(node.expression));
        if (!members) skipped++;
        else {
          const cases = caseLiterals(node);
          const uncovered = members.filter((m) => !cases.includes(m));
          if (uncovered.length) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            const key = `${rel}:${line}`;
            if (!switches.has(key)) {
              switches.set(key, {
                rel,
                line,
                expr: node.expression.getText().slice(0, 40),
                uncovered,
                hasDefault: node.caseBlock.clauses.some(ts.isDefaultClause),
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { tables, switches: [...switches.values()], skipped };
}

function scanRepo() {
  const acc = { tables: [], switches: new Map(), skipped: 0 };
  for (const cfgName of CONFIGS) {
    const cfgPath = path.join(ROOT, cfgName);
    if (!fs.existsSync(cfgPath)) continue;
    const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, ts.sys);
    if (!parsed) continue;
    const files = parsed.fileNames.filter((f) => !TEST_FILE.test(f));
    const r = scanFiles(files, parsed.options, ROOT);
    acc.tables.push(...r.tables);
    for (const s of r.switches) acc.switches.set(`${s.rel}:${s.line}`, s);
    acc.skipped += r.skipped;
  }
  return { tables: acc.tables, switches: [...acc.switches.values()], skipped: acc.skipped };
}

/** 用真 fixture 自检：判据能不能把"少写一个 case / 少写一个键"抓出来。 */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-exhaustive-"));
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
  const cases = [
    {
      name: "switch 漏一档 ⇒ 必须红",
      body: `type M = "a" | "b" | "c";
export function f(m: M): string {
  switch (m) { case "a": return "1"; case "b": return "2"; default: return "3"; }
}
`,
      expectSwitches: 1,
    },
    {
      name: "switch 四档齐 ⇒ 必须绿",
      body: `type M = "a" | "b" | "c";
export function f(m: M): string {
  switch (m) { case "a": return "1"; case "b": return "2"; case "c": return "3"; default: return "3"; }
}
`,
      expectSwitches: 0,
    },
    {
      name: "Record 表漏一键 ⇒ 必须红",
      body: `type M = "a" | "b" | "c";
export const T: Record<M, string> = { a: "1", b: "2" };
`,
      expectTables: 1,
    },
    {
      name: "Record 表键数对齐 ⇒ 必须绿",
      body: `type M = "a" | "b" | "c";
export const T: Record<M, string> = { a: "1", b: "2", c: "3" };
`,
      expectTables: 0,
    },
  ];

  let bad = 0;
  for (const c of cases) {
    write("fixture.ts", c.body);
    const r = scanFiles([path.join(dir, "fixture.ts")], { strict: true, noEmit: true }, dir);
    const gotTables = r.tables.length;
    const gotSwitches = r.switches.length;
    const okTables = c.expectTables === undefined || gotTables === c.expectTables;
    const okSwitches = c.expectSwitches === undefined || gotSwitches === c.expectSwitches;
    const ok = okTables && okSwitches;
    if (!ok) bad++;
    console.log(
      `${ok ? "PASS" : "FAIL"}: ${c.name} — 表 ${gotTables} / switch ${gotSwitches}` +
        (ok ? "" : `（期望 表 ${c.expectTables ?? "-"} / switch ${c.expectSwitches ?? "-"}）`),
    );
  }
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmdirSync(dir);
  // 自检通过**不退出**：带 --selftest 的命令串要接着跑真检查（同 check:scripts-wired
  // 与 check:doc-claims 的做法 —— 把自检钉进命令串，不新增一个"永远没人跑"的脚本）。
  if (bad > 0) process.exit(1);
  console.log("—— 自检通过，接着跑全仓 ——");
}

if (process.argv.includes("--selftest")) selftest();

const findings = scanRepo();
const total = findings.tables.length + findings.switches.length;
if (LIST) {
  console.log(`映射表未对齐 ${findings.tables.length} 处：`);
  for (const t of findings.tables) {
    console.log(`  ${t.rel} · ${t.name}  缺 ${JSON.stringify(t.missing)} 多 ${JSON.stringify(t.extra)}`);
  }
  console.log(`switch 未穷尽 ${findings.switches.length} 处：`);
  for (const s of findings.switches) {
    console.log(
      `  ${s.rel}:${s.line} · switch(${s.expr})  未登记 ${JSON.stringify(s.uncovered)}` +
        (s.hasDefault ? "  ⚠️ 有 default（被吞掉）" : ""),
    );
  }
  console.log(`跳过（联合含非字面量成员）${findings.skipped} 处`);
}
console.log(
  total === 0
    ? "OK：映射表与穷尽 switch 全部逐档登记"
    : `FAIL：${findings.tables.length} 处映射表未对齐 + ${findings.switches.length} 处 switch 未穷尽`,
);
process.exit(total === 0 ? 0 : 1);
