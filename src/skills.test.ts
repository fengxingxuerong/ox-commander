import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_CATALOG_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  formatSkillCatalog,
  mergeSkills,
  normalizeSkill,
  normalizeSkillName,
  parseSkillDoc,
  type NormalizeSkillResult,
  type Skill,
} from "../shared/skills";

/**
 * 技能层的判据全在"坏输入该怎么办"上：手写 SKILL.md 是用户可控的自由文本，
 * 而它直接进系统提示。这里钉三件事 —— 坏技能**只报不抛**、描述与目录**截断说破**、
 * 同名**项目覆盖全局**。判错的形态都不吵：技能静默消失、模型以为看全了、
 * 用户改了项目里那份却一直读全局那份。
 */
const doc = (front: string, body = "正文"): string => `---\n${front}\n---\n${body}\n`;

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "run-verify",
  description: "跑本项目 verify 并解读失败",
  origin: "project",
  path: ".ox/skills/run-verify/SKILL.md",
  bodyChars: 12,
  enabled: true,
  ...over,
});

function ok(result: NormalizeSkillResult): Skill {
  if ("error" in result) throw new Error(`期望通过，实际判坏：${result.error}`);
  return result.skill;
}

describe("parseSkillDoc", () => {
  it("取出 front matter 的键值，正文原样留下", () => {
    const parsed = parseSkillDoc(doc("name: demo\ndescription: 做演示", "第一行\n第二行"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields).toEqual({ name: "demo", description: "做演示" });
    expect(parsed.body).toBe("第一行\n第二行\n");
  });

  it("去掉 BOM 并把 CRLF 归一（Windows 上手写的文件必须能读）", () => {
    const parsed = parseSkillDoc(`\uFEFF---\r\nname: demo\r\n---\r\n正文\r\n`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields.name).toBe("demo");
    expect(parsed.body).toBe("正文\n");
  });

  it("没有 front matter 判坏，且正文不被吞掉", () => {
    const parsed = parseSkillDoc("# 直接写正文\n");
    expect(parsed.issues[0]).toMatch(/缺少 front matter/);
    expect(parsed.body).toContain("直接写正文");
  });

  it("front matter 没闭合判坏（否则会把整篇当元数据）", () => {
    const parsed = parseSkillDoc("---\nname: demo\n");
    expect(parsed.issues[0]).toMatch(/没有结束的 ---/);
  });

  it("坏行只报那行，其余键照收（一行的错不该让整个技能消失）", () => {
    const parsed = parseSkillDoc(doc("name: demo\n这一行没有冒号\ndescription: 用途"));
    expect(parsed.fields).toEqual({ name: "demo", description: "用途" });
    expect(parsed.issues[0]).toMatch(/第 2 行不是 key: value/);
  });

  it("引号包着的值去掉引号，注释行与空行忽略", () => {
    const parsed = parseSkillDoc(doc('# 注释\nname: "demo"\ndescription: \'带:冒号\''));
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields).toEqual({ name: "demo", description: "带:冒号" });
  });

  it("引号不配对就一个都不剥（半截引号是坏输入，剥一半会吞掉正文首尾）", () => {
    // 只剥「首尾是同一种引号」的成对包裹。首尾异种时整串原样保留 ——
    // 手写 SKILL.md 时最常见的错法就是引号只写了一半，此时把第一个字符
    // 剥掉等于替用户把正文吃掉一个字，而报错线索（那个孤引号）也一起没了。
    const leading = parseSkillDoc(doc('name: demo\ndescription: "双引号开头单引号结尾\''));
    expect(leading.issues).toEqual([]);
    expect(leading.fields.description).toBe('"双引号开头单引号结尾\'');
    const trailing = parseSkillDoc(doc("name: demo\ndescription: '单引号开头双引号结尾\""));
    expect(trailing.issues).toEqual([]);
    expect(trailing.fields.description).toBe("'单引号开头双引号结尾\"");
  });
});

describe("normalizeSkillName", () => {
  it("接受 kebab-case", () => {
    expect(normalizeSkillName("run-verify")).toBe("run-verify");
    expect(normalizeSkillName("a1")).toBe("a1");
    expect(normalizeSkillName("  trimmed  ")).toBe("trimmed");
  });

  it("拒绝大写/下划线/空格/首尾连字符 —— 不静默改写（改写会让两个写法指向同一技能）", () => {
    expect(normalizeSkillName("RunVerify")).toBeUndefined();
    expect(normalizeSkillName("run_verify")).toBeUndefined();
    expect(normalizeSkillName("run verify")).toBeUndefined();
    expect(normalizeSkillName("-demo")).toBeUndefined();
    expect(normalizeSkillName("demo-")).toBeUndefined();
    expect(normalizeSkillName("a--b")).toBeUndefined();
    expect(normalizeSkillName("")).toBeUndefined();
    expect(normalizeSkillName(42)).toBeUndefined();
  });

  it("超过 64 字符拒绝", () => {
    expect(normalizeSkillName("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeSkillName("a".repeat(65))).toBeUndefined();
  });
});

describe("normalizeSkill", () => {
  it("front matter 没写 name 时用目录名", () => {
    const s = ok(normalizeSkill({ dirName: "run-verify", origin: "project", path: "p", text: doc("description: 用途") }));
    expect(s.name).toBe("run-verify");
    expect(s.origin).toBe("project");
    expect(s.bodyChars).toBe(2);
  });

  it("写了 name 就用它（目录名只是默认值）", () => {
    const s = ok(
      normalizeSkill({ dirName: "目录名", origin: "global", path: "p", text: doc("name: named\ndescription: 用途") }),
    );
    expect(s.name).toBe("named");
    expect(s.origin).toBe("global");
  });

  it("名字不合法时说清是超长还是形状不对", () => {
    // 先落地成"结果对象"再断言：`NormalizeSkillResult` 是联合类型，在 `in` 判断
    // **外面**访问 `.error` 编译不过（这是好事 —— 它逼着先判是哪一支）。
    const bad = (name: string) => {
      const r = normalizeSkill({
        dirName: "x",
        origin: "project",
        path: "p",
        text: doc(`name: ${name}\ndescription: 用途`),
      });
      return r;
    };
    const upper = bad("BadName");
    expect("error" in upper && upper.error).toMatch(/kebab-case/);
    const long = bad("a".repeat(65));
    expect("error" in long && long.error).toMatch(/超过 64 字符/);
  });

  it("目录名本身不合法也判坏（默认值同样过尺子）", () => {
    const r = normalizeSkill({ dirName: "Bad Dir", origin: "project", path: "p", text: doc("description: 用途") });
    expect("error" in r && r.error).toMatch(/Bad Dir/);
  });

  it("缺 description 判坏，并说明该写什么", () => {
    const r = normalizeSkill({ dirName: "demo", origin: "project", path: "p", text: doc("name: demo") });
    expect("error" in r && r.error).toMatch(/缺少 description/);
  });

  it("description 超长截断并留标记（界面要说破原文更长）", () => {
    const long = "长".repeat(MAX_SKILL_DESCRIPTION_CHARS + 5);
    const s = ok(normalizeSkill({ dirName: "demo", origin: "project", path: "p", text: doc(`description: ${long}`) }));
    expect(s.description).toHaveLength(MAX_SKILL_DESCRIPTION_CHARS);
    expect(s.descriptionTruncated).toBe(true);

    const short = ok(normalizeSkill({ dirName: "demo", origin: "project", path: "p", text: doc("description: 短") }));
    expect(short.descriptionTruncated).toBeUndefined();
  });

  it("enabled 只认显式 false（默认启用；存盘回来 undefined 不该被当成停用）", () => {
    const on = ok(normalizeSkill({ dirName: "demo", origin: "project", path: "p", text: doc("description: 用途") }));
    expect(on.enabled).toBe(true);
    const off = ok(
      normalizeSkill({ dirName: "demo", origin: "project", path: "p", text: doc("description: 用途"), enabled: false }),
    );
    expect(off.enabled).toBe(false);
  });
});

describe("mergeSkills", () => {
  it("同名时项目级覆盖全局级（反向覆盖会让项目里那份永远不生效）", () => {
    const merged = mergeSkills([
      skill({ name: "deploy", origin: "global", description: "全局的" }),
      skill({ name: "deploy", origin: "project", description: "项目的" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("项目的");
  });

  it("全局只在那一个名字没被项目占用时留下", () => {
    const merged = mergeSkills([
      skill({ name: "deploy", origin: "global", description: "全局的" }),
      skill({ name: "lint", origin: "project", description: "项目的" }),
    ]);
    expect(merged.map((s) => s.name)).toEqual(["deploy", "lint"]);
    expect(merged[0]?.origin).toBe("global");
  });

  it("按名字排序（目录顺序稳定，提示不因扫描顺序变）", () => {
    const merged = mergeSkills([
      skill({ name: "zebra" }),
      skill({ name: "alpha" }),
      skill({ name: "middle" }),
    ]);
    expect(merged.map((s) => s.name)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("同一层里重名时先扫到的赢（扫描顺序 = 项目先、全局后，结果可复现）", () => {
    const merged = mergeSkills([
      skill({ name: "deploy", origin: "global", description: "先" }),
      skill({ name: "deploy", origin: "global", description: "后" }),
    ]);
    expect(merged[0]?.description).toBe("先");
  });
});

describe("formatSkillCatalog", () => {
  it("没有技能时给空串（空块是纯噪声）", () => {
    expect(formatSkillCatalog([]).text).toBe("");
    expect(formatSkillCatalog([skill({ enabled: false })]).text).toBe("");
  });

  it("头里点名 read_skill 并声明「背景不是合同」", () => {
    const { text } = formatSkillCatalog([skill()]);
    expect(text).toContain("read_skill");
    expect(text).toContain("以契约为准");
    expect(text).toContain("- run-verify：跑本项目 verify 并解读失败");
  });

  it("停用的技能不进目录，但计入 total（它确实存在，只是没启用）", () => {
    const catalog = formatSkillCatalog([skill(), skill({ name: "off", enabled: false })]);
    expect(catalog.text).not.toContain("off");
    expect(catalog.total).toBe(1);
  });

  it("预算不够时按整条跳过，并把没列的名字说破", () => {
    const skills = [skill({ name: "aa", description: "x".repeat(40) }), skill({ name: "bb", description: "y".repeat(40) })];
    const catalog = formatSkillCatalog(skills, 180);
    expect(catalog.shown).toBeLessThan(2);
    expect(catalog.total).toBe(2);
    expect(catalog.dropped.length).toBe(2 - catalog.shown);
    for (const name of catalog.dropped) expect(catalog.text).toContain(name);
    expect(catalog.text).toContain("可以用 read_skill");
  });

  it("第一条超预算只丢它自己：更短的技能仍按序入列", () => {
    // 预算判定是「逐条累加」，不是「碰到第一条超了就放弃整个目录」——
    // 一份长描述把循环顶掉的话，用户看到的是「所有技能都没了」，
    // 而真实原因（那一条超了）反而被藏住。
    const skills = [skill({ name: "aa", description: "x".repeat(200) }), skill({ name: "bb", description: "短" })];
    const catalog = formatSkillCatalog(skills, 300);
    expect(catalog.shown).toBe(1);
    expect(catalog.dropped).toEqual(["aa"]);
    expect(catalog.text).toContain("- bb：短");
    expect(catalog.text).not.toContain("一个都没列出来");
  });

  it("一条都放不下时仍给头与全部名字（否则表现为「没有技能」）", () => {
    const catalog = formatSkillCatalog([skill({ name: "aa" })], 10);
    expect(catalog.shown).toBe(0);
    expect(catalog.text).toContain("一个都没列出来");
    expect(catalog.text).toContain("aa");
  });

  it("默认预算内放得下就原样列出，尾注只在真有丢弃时出现", () => {
    const catalog = formatSkillCatalog([skill()]);
    expect(catalog.dropped).toEqual([]);
    expect(catalog.text).not.toContain("超出");
    expect(MAX_SKILL_CATALOG_CHARS).toBeGreaterThan(1_000);
  });
});
