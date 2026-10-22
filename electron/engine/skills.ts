/**
 * 技能目录扫描（M6a）。
 *
 * 纯读盘、零判断：怎么解析、什么算坏技能、目录块长什么样，全归
 * `shared/skills.ts` —— 那一层是纯函数，双端（桌面 / headless）共用同一套口径。
 * 这里只负责"扫得到就扫，扫不到当没有"，与 `conventions.ts` 是同一个形状。
 *
 * 三条纪律（沿用约定扫描那一套）：
 * 1. **坏技能只报不抛**：一个手写坏的 SKILL.md 不该让整个目录读不出来，更不该
 *    让会话起不来。缺席与读不到在语义上是同一件事（没有这个技能），但后者值得
 *    报出去 —— 界面要能告诉用户"你这份文件哪里不对"。
 * 2. **读目录失败当空**：`.ox/skills` 不存在是常态（大多数项目还没有技能），
 *    抛异常会让调用方到处包 try/catch，最终演变成 `catch {}` 吞掉真错误。
 * 3. **超预算的全文不读**：技能全文动辄几千字，这里只统计长度（`bodyChars`），
 *    全文由 `read_skill` 按需取。
 */
import fs from "node:fs";
import path from "node:path";

import {
  SKILL_FILE_NAME,
  mergeSkills,
  normalizeSkill,
  type Skill,
  type SkillIssue,
} from "../../shared/skills";

/** 单个 SKILL.md 的读取上限：超过就判坏（与约定文件的 256KB 同口径）。 */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** 扫描结果。 */
export interface ReadSkillsResult {
  /** 可用技能（项目级覆盖全局级，按名字排序）。 */
  skills: Skill[];
  /** 读不动/判坏的技能：路径 + 能照做的原因。 */
  issues: SkillIssue[];
}

export interface SkillSource {
  origin: "project" | "global";
  /** 技能目录的父目录（其下每个子目录是一个技能）。 */
  rootAbs: string;
}

/**
 * 扫一个技能根目录下的所有 `<技能目录>/SKILL.md`。
 *
 * 子目录名即技能默认名：front matter 里没写 `name` 时用它 —— 这样"目录名起对了
 * 也是合法技能"，用户不必为了多写一行 YAML 才肯用。
 */
function scanRoot(source: SkillSource, out: ReadSkillsResult): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source.rootAbs, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 常态，不是错误（纪律 2）
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const abs = path.join(source.rootAbs, dirName, SKILL_FILE_NAME);
    // 展示路径：项目内用相对 POSIX 路径（与工具路径判定的口径一致），
    // 全局用绝对路径（它本来就不在项目里，硬凑相对路径反而看不出在哪）。
    const shown =
      source.origin === "project"
        ? `.ox/skills/${dirName}/${SKILL_FILE_NAME}`
        : abs;
    let bytes: number;
    try {
      bytes = fs.statSync(abs).size;
    } catch {
      continue; // 没有 SKILL.md 的目录不是技能（可能装了脚本/资源）
    }
    if (bytes > MAX_SKILL_FILE_BYTES) {
      out.issues.push({ path: shown, reason: `文件过大（${bytes} 字节，上限 ${MAX_SKILL_FILE_BYTES}）` });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (err) {
      out.issues.push({ path: shown, reason: `读取失败：${(err as Error).message}` });
      continue;
    }
    const result = normalizeSkill({
      dirName,
      origin: source.origin,
      path: shown,
      text,
      // 停用标志读同目录的 `.disabled` 标记文件：删文件=删技能，禁用只是让它
      // 不进目录，两者不能混 —— 用户禁用一个技能是为了"先别用"，不是"删掉"。
      enabled: !fs.existsSync(path.join(source.rootAbs, dirName, ".disabled")),
    });
    if ("error" in result) out.issues.push({ path: shown, reason: result.error });
    else out.skills.push(result.skill);
  }
}

/**
 * 读技能目录。
 *
 * 顺序固定为"先全局后项目"，覆盖方向由 `mergeSkills` 决定（项目级压过全局级）——
 * 扫描顺序只影响**同名时的取舍依据**，不影响最终排序（按名字排）。
 */
export function readSkills(sources: readonly SkillSource[]): ReadSkillsResult {
  const out: ReadSkillsResult = { skills: [], issues: [] };
  for (const source of sources) scanRoot(source, out);
  out.skills = mergeSkills(out.skills);
  return out;
}
