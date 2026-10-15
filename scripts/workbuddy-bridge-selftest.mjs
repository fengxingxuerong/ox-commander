/**
 * 门禁：WorkBuddy 桥（`scripts/workbuddy-bridge.mjs`）的沙箱判定 —— 它放行谁、拦谁。
 *
 * 为什么值得单独一道门禁：这个桥是**对话式智能体被桌面端引擎指挥**的唯一入口
 * （`npm run bridge:workbuddy`，ox-agent/2 协议）。平台把 TaskRequest 派给它，
 * 它把成果按 zone 写进 projectRoot —— **写哪里这一件事没有任何别的判据在看**：
 *   - 判松 → 智能体可以借一次派单改写 zone 外的文件（package.json / .env / 别的 zone），
 *     而平台侧只看到"交付成功"；
 *   - 判严 → 合法交付被拒，症状是"任务全红在越权"，而 zone 契约其实是对的。
 * 2026-10-15 实测到的就是第二种：桥没有平台 `shared/glob.ts → isPathInZone` 的
 * `z.` 前缀规则，zone 取"文件名级"粒度（`src/parse`）时，契约要求的字面路径
 * `src/parse.js` 被判越权，两个任务当场 no agent available / 越权回滚。
 *
 * 所以这里逐条钉住期望：口径不是桥自己说了算，而是**与平台 `isPathInZone` 逐字对齐**。
 * 两边哪天分叉，这道自测红 —— 分叉的方向永远是"合法交付被拒"或"越权被放行"，
 * 没有"只是数字不好看"这一种。
 *
 * 手法与 `masker-selftest.mjs` 一致：桥的顶层有 `server.listen`，不能 import，
 * 于是按锚点把判定区抠出来注进新作用域（只注入 `path`），不留第二份实现。
 *
 * 用法：node scripts/workbuddy-bridge-selftest.mjs   （有任何一条不符时 exit 1）
 */
import path from "node:path";
import os from "node:os";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "workbuddy-bridge.mjs");

// 抠出「受保护名单 + assertWritable + takeResult + writeFiles」这一区：锚点是桥里那句
// 文档注释与 `startRun` 的函数头，判定区搬家会跟着它走。
const src = readFileSync(BRIDGE, "utf8");
const start = src.indexOf("const FORBIDDEN_TOPS");
const end = src.indexOf("function startRun(run) {");
if (start < 0 || end < 0 || end <= start) {
  console.error("无法在 workbuddy-bridge.mjs 里定位沙箱判定区（锚点被改名或移动了？）");
  process.exit(2);
}
const { assertWritable, writeFiles } = new Function(
  "path",
  "fs",
  `${src.slice(start, end)}\nreturn { assertWritable, writeFiles };`,
)(path, fs);

/**
 * 每条用例：`want` 是期望返回的归一化路径（放行），或 `{ throw: "<消息片段>" }`（拦截）。
 * 判据一律对齐平台 `shared/glob.ts` 的 `isPathInZone`，不按桥的现状描述。
 */
const cases = [
  // ---- 放行：zone 内的正常交付 ----
  { name: "zone 内的直接子文件", zone: "src", rel: "src/parse.js", want: "src/parse.js" },
  { name: "zone 本身就是目标文件（norm === zone）", zone: "src/parse.js", rel: "src/parse.js", want: "src/parse.js" },
  {
    // 平台 isPathInZone 的 `z.` 分支：zone 取"文件名级"粒度时，契约要求的字面路径算 zone 内。
    // 2026-10-15 桥缺这一条，两个任务当场被判越权。
    name: "zone 少一层扩展名时，契约字面路径仍算 zone 内（z. 前缀规则）",
    zone: "src/parse",
    rel: "src/parse.js",
    want: "src/parse.js",
  },
  { name: "zone 带尾部分隔符不影响判定", zone: "src/", rel: "src/a.js", want: "src/a.js" },
  { name: "zone 为 . 时不按 zone 拦（平台同款：. 声称整棵树）", zone: ".", rel: "docs/x.md", want: "docs/x.md" },
  { name: "zone 为空串时不按 zone 拦", zone: "", rel: "docs/x.md", want: "docs/x.md" },
  { name: "Windows 反斜杠在正斜杠空间里比（onboarding §6 的坑）", zone: "src\\parse", rel: "src\\parse.js", want: "src/parse.js" },
  { name: "返回值归一成正斜杠", zone: "src", rel: "src\\a.js", want: "src/a.js" },

  // ---- 拦截：越权 ----
  { name: "zone 外一律越权", zone: "src", rel: "README.md", want: { throw: "越权" } },
  {
    // z. 分支的边界：`rest` 里再出现 `/` 就不算 —— zone "src/parse" 不拥有 src/parsed/ 下的文件。
    name: "z. 规则不跨目录（src/parsed/ 下的文件不算 src/parse 的）",
    zone: "src/parse",
    rel: "src/parsed/inner.js",
    want: { throw: "越权" },
  },
  {
    // 平台 `rest !== ""` 那条：`src/parse.` 这种"扩展名为空"的路径不算 zone 内。
    name: "z. 分支要求扩展名非空（src/parse. 不算）",
    zone: "src/parse",
    rel: "src/parse.",
    want: { throw: "越权" },
  },
  { name: "同层的别的文件不算（zone 是 src/parse 时 src/other.js 越权）", zone: "src/parse", rel: "src/other.js", want: { throw: "越权" } },

  // ---- 拦截：受保护名单（与 zone 无关，优先判）----
  { name: "受保护顶层目录：node_modules", zone: "src", rel: "node_modules/x/index.js", want: { throw: "拒绝受保护目录" } },
  { name: "受保护顶层目录：.git", zone: "src", rel: ".git/config", want: { throw: "拒绝受保护目录" } },
  { name: "受保护顶层目录：dist（构建产物）", zone: "src", rel: "dist/index.html", want: { throw: "拒绝受保护目录" } },
  {
    // package.json 里躺着整条 verify 链的段名：被改写 = 门禁自己被改，这不属于任何 zone 的交付。
    name: "受保护文件：package.json",
    zone: "src",
    rel: "package.json",
    want: { throw: "拒绝受保护文件" },
  },
  { name: "受保护文件：.env（密钥）", zone: "src", rel: ".env", want: { throw: "拒绝受保护文件" } },
  { name: "受保护文件：package-lock.json", zone: "src", rel: "package-lock.json", want: { throw: "拒绝受保护文件" } },

  // ---- 拦截：路径形态 ----
  { name: "绝对路径直接拒", zone: "src", rel: "D:/evil/x.js", want: { throw: "拒绝绝对路径" } },
  { name: "UNC 路径直接拒", zone: "src", rel: "\\\\?\\D:\\evil\\x.js", want: { throw: "拒绝绝对路径" } },
  { name: "藏在中间的路径穿越拒", zone: "src", rel: "src/..hidden/x.js", want: { throw: "拒绝路径穿越" } },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  let got;
  let threw = null;
  try {
    got = assertWritable(c.zone, c.rel);
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  const ok =
    typeof c.want === "string" ? threw === null && got === c.want : threw !== null && threw.includes(c.want.throw);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `✗ ${c.name}（zone=${c.zone} rel=${c.rel}）  期望 ${
        typeof c.want === "string" ? `放行 → ${c.want}` : `拦截 → ${c.want.throw}`
      }，实得 ${threw === null ? `放行 → ${got}` : `拦截 → ${threw}`}`,
    );
  }
}

/*
 * 第二批：`writeFiles` 的**整批原子性**。
 *
 * 2026-10-15 真进程探针实测到的洞：旧实现边校验边写，成果里第一份在 zone 内、
 * 第二份越权时，第一份已经落盘了 —— 而桥回给平台的只有 `failed`（不带文件清单），
 * 平台那侧 `arbitration: revert-batch` 拿不到产物路径，回滚根本覆盖不到这半个文件。
 * 于是"被拒的一批"会在目标项目里留下一份从未通过验证的半成品，下一轮重修还踩着它。
 * 现在的口径：任一文件被拒 ⇒ 整批一个字节都不写。
 *
 * 每条用例都跑在临时目录里，绝不碰仓库树。
 */
const wcases = [
  {
    name: "整批合法 → 两份都落盘",
    zone: "src",
    files: [
      { path: "src/a.js", content: "A" },
      { path: "src/b.js", content: "BB" },
    ],
    want: { throw: null, expect: { "src/a.js": "A", "src/b.js": "BB" } },
  },
  {
    name: "第二份越权 → 整批不写（第一份也不留）",
    zone: "src",
    files: [
      { path: "src/a.js", content: "A" },
      { path: "README.md", content: "E" },
    ],
    want: { throw: "越权", expect: {} },
  },
  {
    name: "越权那份在第一 → 整批不写",
    zone: "src",
    files: [
      { path: "docs/x.md", content: "X" },
      { path: "src/a.js", content: "A" },
    ],
    want: { throw: "越权", expect: {} },
  },
  {
    name: "受保护文件混在合法批次里 → 整批不写",
    zone: ".",
    files: [
      { path: "src/a.js", content: "A" },
      { path: "package.json", content: "{}" },
    ],
    want: { throw: "拒绝受保护文件", expect: {} },
  },
  {
    name: "合法 + 子目录新建 → 都落盘",
    zone: "src",
    files: [{ path: "src/deep/nested/c.js", content: "C" }],
    want: { throw: null, expect: { "src/deep/nested/c.js": "C" } },
  },
  {
    name: "空文件清单 → 拒，且不建任何东西",
    zone: "src",
    files: [],
    want: { throw: "成果里没有文件", expect: {} },
  },
];

for (const c of wcases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-wb-writefiles-"));
  let threw = null;
  try {
    writeFiles({ task: { zone: c.zone, projectRoot: root }, result: { files: c.files } });
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  const onDisk = {};
  for (const rel of Object.keys(c.want.expect)) {
    try {
      onDisk[rel] = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      onDisk[rel] = null;
    }
  }
  const stray = (() => {
    // 期望"什么都不写"时，盘上多出任何文件都算违反原子性。
    const walk = (dir) =>
      fs.existsSync(dir)
        ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
        : [];
    return walk(root).length;
  })();
  const wantFiles = c.want.expect;
  const contentOk = Object.entries(wantFiles).every(([rel, content]) => onDisk[rel] === content);
  const ok =
    c.want.throw === null
      ? threw === null && contentOk
      : threw !== null && threw.includes(c.want.throw) && stray === 0;
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `✗ ${c.name}  期望 ${
        c.want.throw === null ? "整批落盘" : `拦截 → ${c.want.throw} 且盘上零文件`
      }，实得 ${threw === null ? `放行（盘上 ${stray} 个文件）` : `拦截 → ${threw}（盘上 ${stray} 个文件）`}`,
    );
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

console.log(`WorkBuddy 桥沙箱判定自测：${pass}/${cases.length + wcases.length} 通过`);
if (fail > 0) {
  console.error(
    "  判据口径是平台 shared/glob.ts 的 isPathInZone + 桥里的受保护名单 + 整批原子性；" +
      "两边分叉时改桥去对齐平台，别改这条用例来迁就现状。",
  );
  process.exit(1);
}
