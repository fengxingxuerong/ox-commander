/**
 * 技能（Skills，M6）的**纯**逻辑：SKILL.md 的 front matter 解析、名字与描述的
 * 校验、目录块拼装与预算截断、项目/全局同名去重。
 *
 * 与 `project-conventions.ts` 的分工：那份管"项目所有者写的约定"，是**背景**，
 * 一次全量注入；本文件管"可被按需取用的技能"，目录（name + description）常驻，
 * 全文要靠 `read_skill` 现取 —— 两者同一个注入顺序位（约定之后、平台契约之前），
 * 但注入量差一个数量级：技能全文动辄几千字，十几个技能全塞进去就把上下文吃光。
 *
 * 三条纪律：
 * 1. **坏技能只报不抛**（与 `session-store` / `project-conventions` 同款）：一个
 *    手写坏的 SKILL.md 不该让整个技能目录读不出来，也不该让会话起不来；
 * 2. **截断必须说破**：目录超预算时写明"原有多少个、这里列了多少个、剩下的名字
 *    是什么" —— 静默截断会让模型以为自己看全了，然后回答"没有这个技能"；
 * 3. **同一把尺子**：`name` / `description` 只在这里归一化，扫描（读盘）、新建
 *    （写盘）、界面展示都走它。两套尺子分叉的结果是"能建出来但读不回来"。
 */

/** 技能定义文件名（每个技能一个目录，目录名即默认技能名）。 */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * 技能名：kebab-case（小写字母/数字，单连字符分隔）。
 *
 * 为什么卡这么死：技能名会进提示、进 `read_skill` 的参数、进界面路由的 key。
 * 允许大写/空格/中文的结果是"用户能用两种写法指同一个技能"，而模型只会用其中
 * 一种 —— 报错文案就成了唯一线索。名字是标识符，不是标题（标题放 description）。
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SKILL_NAME_CHARS = 64;
/** 描述长度上限：目录里一行一个技能，长描述会把目录变成第二份全文。 */
export const MAX_SKILL_DESCRIPTION_CHARS = 160;
/** 目录块总字符预算（所有技能的描述加起来）。 */
export const MAX_SKILL_CATALOG_CHARS = 4_000;

/** 技能来源：项目内（`.ox/skills`）还是全局（用户数据目录）。 */
export type SkillOrigin = "project" | "global";

/** 一个通过校验的技能（扫描层的产物，界面与提示都读它）。 */
export interface Skill {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** 展示用路径（项目内为相对项目根的 POSIX 路径，全局为绝对路径）。 */
  path: string;
  /** 全文长度（字符），让模型知道"读全文值不值"。 */
  bodyChars: number;
  /** 描述超长被截断过（界面据此提示"原文更长"）。 */
  descriptionTruncated?: boolean;
  /** 停用的技能不进目录、`read_skill` 拒绝，但仍在技能页列出来（可查原因）。 */
  enabled: boolean;
}

/** 读不动的技能：路径 + 原因（`skills:list` 原样交给界面）。 */
export interface SkillIssue {
  path: string;
  reason: string;
}

export interface ParsedSkillDoc {
  fields: Record<string, string>;
  body: string;
  /** 解析过程中的问题（缺 front matter、坏行……）。非空即该技能被判坏。 */
  issues: string[];
}

/**
 * 解析 `---` 包起来的 front matter。只认 `key: value` 单行形式 —— 技能元数据
 * 只有 name / description 两项，为此引一个 YAML 解析器不划算，而"半支持 YAML"
 * （嵌套、多行、锚点）比不支持更糟：用户会以为它能用。
 */
export function parseSkillDoc(text: string): ParsedSkillDoc {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      fields: {},
      body: normalized,
      issues: [`缺少 front matter（文件必须以 --- 开头，里面写 name 与 description）`],
    };
  }
  const rest = normalized.slice(4);
  const end = rest.indexOf("\n---");
  if (end === -1) {
    return { fields: {}, body: normalized, issues: ["front matter 没有结束的 ---"] };
  }
  const header = rest.slice(0, end);
  // 结束行之后的正文：跳过 `---` 与紧随的一个换行。
  const afterEnd = rest.slice(end + 4);
  const body = afterEnd.startsWith("\n") ? afterEnd.slice(1) : afterEnd;

  const fields: Record<string, string> = {};
  const issues: string[] = [];
  header.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) {
      issues.push(`front matter 第 ${i + 1} 行不是 key: value：${trimmed.slice(0, 40)}`);
      return;
    }
    const key = trimmed.slice(0, sep).trim();
    const value = unquote(trimmed.slice(sep + 1).trim());
    if (key === "") {
      issues.push(`front matter 第 ${i + 1} 行缺键名`);
      return;
    }
    fields[key] = value;
  });
  return { fields, body, issues };
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1);
  }
  return raw;
}

/** 名字归一化：trim + 校验；不合法返回 undefined（不静默改写成合法形态）。 */
export function normalizeSkillName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name === "" || name.length > MAX_SKILL_NAME_CHARS) return undefined;
  return SKILL_NAME_RE.test(name) ? name : undefined;
}

export interface NormalizeSkillInput {
  /** 目录名（SKILL.md 所在目录），front matter 里没写 name 时用它。 */
  dirName: string;
  origin: SkillOrigin;
  path: string;
  text: string;
  enabled?: boolean;
}

export type NormalizeSkillResult = { skill: Skill } | { error: string };

/**
 * 把一份 SKILL.md 归一成 Skill。判坏一律给出**能照做**的原因（缺什么、哪一行、
 * 名字该长什么样），因为这条错误最终会出现在技能页上给用户看。
 */
export function normalizeSkill(input: NormalizeSkillInput): NormalizeSkillResult {
  const parsed = parseSkillDoc(input.text);
  if (parsed.issues.length > 0) return { error: parsed.issues.join("；") };

  const declared = parsed.fields.name;
  const name = normalizeSkillName(declared === undefined || declared === "" ? input.dirName : declared);
  if (name === undefined) {
    const shown = declared === undefined || declared === "" ? input.dirName : declared;
    return {
      error: `技能名不合法：${shown}（${
        String(shown).length > MAX_SKILL_NAME_CHARS ? `超过 ${MAX_SKILL_NAME_CHARS} 字符` : "要求 kebab-case：小写字母/数字，连字符分隔"
      }）`,
    };
  }

  const rawDescription = (parsed.fields.description ?? "").trim();
  if (rawDescription === "") {
    return { error: "缺少 description（front matter 里写上「什么时候该用这个技能」）" };
  }
  const truncated = rawDescription.length > MAX_SKILL_DESCRIPTION_CHARS;
  const description = truncated ? rawDescription.slice(0, MAX_SKILL_DESCRIPTION_CHARS) : rawDescription;

  return {
    skill: {
      name,
      description,
      origin: input.origin,
      path: input.path,
      bodyChars: parsed.body.trim().length,
      ...(truncated ? { descriptionTruncated: true } : {}),
      enabled: input.enabled !== false,
    },
  };
}

/**
 * 同名去重：**项目级覆盖全局级**。
 *
 * 理由是覆盖方向不能反过来 —— 全局技能是"我在所有项目里都这么干"，项目技能是
 * "这个项目例外"。若全局优先，项目目录里的同名文件就永远不生效，而用户改的是
 * 项目里那份，会得到"改了没用"的结论。
 */
export function mergeSkills(skills: readonly Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (existing === undefined || (existing.origin === "global" && skill.origin === "project")) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

export const SKILL_CATALOG_MARKER = "【可用技能（项目 .ox/skills 与全局技能目录）】";

export interface SkillCatalog {
  /** 拼好的目录块；没有可用技能时为空串（调用方据此不拼，空块是纯噪声）。 */
  text: string;
  shown: number;
  total: number;
  /** 因预算没列出来的技能名（按名字排序，已截断过长的清单本身）。 */
  dropped: string[];
}

/**
 * 目录块。每条只给 `name：description`，并明确"全文要用 read_skill 取"——
 * 模型不会自己发明工具名，工具得在块里被点名。
 *
 * 预算按**整条**累加（不是先拼完再切）：先拼后切会把最后一条的描述剁掉一半，
 * 而半句话比没有更误导。
 */
export function formatSkillCatalog(
  skills: readonly Skill[],
  budget: number = MAX_SKILL_CATALOG_CHARS,
): SkillCatalog {
  const usable = mergeSkills(skills).filter((s) => s.enabled);
  if (usable.length === 0) return { text: "", shown: 0, total: 0, dropped: [] };

  const head = [
    SKILL_CATALOG_MARKER,
    "以下是这个项目里可用的技能（只给名字与用途）。需要某个技能的完整说明时，",
    "调用 read_skill（参数 name 就是下面列出的名字）。技能是背景而不是合同：",
    "与本次任务的契约冲突时，以契约为准。",
  ].join("\n");

  const lines: string[] = [];
  let used = head.length;
  const dropped: string[] = [];
  for (const skill of usable) {
    const line = `- ${skill.name}：${skill.description}`;
    if (used + line.length + 1 > budget) {
      dropped.push(skill.name);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  // 一条都没放下时也要给头 —— 否则"有技能但全被预算挡了"会表现为"没有技能"。
  if (lines.length === 0) {
    return {
      text: `${head}\n（技能目录超出 ${budget} 字符预算，${usable.length} 个技能一个都没列出来：${usable
        .map((s) => s.name)
        .join("、")}；可以用 read_skill 直接按名字取）`,
      shown: 0,
      total: usable.length,
      dropped,
    };
  }

  const tail =
    dropped.length > 0
      ? `\n（目录超出 ${budget} 字符预算：共 ${usable.length} 个技能，这里列了 ${lines.length} 个；` +
        `没列的 ${dropped.length} 个是 ${dropped.join("、")} —— 仍然可以用 read_skill 按名字取）`
      : "";
  return { text: `${head}\n${lines.join("\n")}${tail}`, shown: lines.length, total: usable.length, dropped };
}
