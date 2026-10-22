import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readSkills } from "../electron/engine/skills";

/**
 * 技能目录扫描（M6a）。
 *
 * 这一层是"文档 → 目录"的唯一入口，错法都是**静默**的：技能少了一半没人知道、
 * 坏技能被当成不存在、项目级被全局级顶掉。所以每条纪律都落到具体的盘上布局：
 *   ① 目录不存在 = 空，不是错误（大多数项目还没有技能）；
 *   ② 没有 SKILL.md 的子目录不是技能（可能装脚本/资源），不该报问题；
 *   ③ 坏技能进 `issues` 而不是消失 —— 用户改的是那份文件，看不见原因就改不对；
 *   ④ 项目级覆盖全局级（覆盖方向反了就是"改了没用"）。
 */
const roots: string[] = [];

function dir(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-skills-${tag}-`));
  roots.push(root);
  return root;
}

const doc = (name: string, description: string, body = "正文"): string =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", body].join("\n");

function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("readSkills", () => {
  it("目录不存在 = 空结果（不是错误，也不暗示「没有这个技能」）", () => {
    const root = dir("a");
    const res = readSkills([{ origin: "project", rootAbs: path.join(root, ".ox", "skills") }]);
    expect(res.skills).toEqual([]);
    expect(res.issues).toEqual([]);
  });

  it("目录名即默认技能名（front matter 里不写 name 也算数）", () => {
    const project = dir("a2");
    put(project, ".ox/skills/ship-it/SKILL.md", ["---", "description: 上线前该做什么", "---", "", "一、二、三"].join("\n"));
    const ok = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(ok.skills.map((s) => s.name)).toEqual(["ship-it"]);
    expect(ok.skills[0]?.origin).toBe("project");
    expect(ok.skills[0]?.bodyChars).toBe("一、二、三".length);
    // 展示路径是相对项目的 POSIX 路径（与工具路径口径一致）。
    expect(ok.skills[0]?.path).toBe(".ox/skills/ship-it/SKILL.md");
  });

  it("没有 SKILL.md 的子目录不是技能，也不报问题（可能是脚本/资源）", () => {
    const project = dir("b");
    put(project, ".ox/skills/helper/run.sh", "echo hi");
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills).toEqual([]);
    expect(res.issues).toEqual([]);
  });

  it("坏技能进 issues：原因能照着改，不是「不存在」", () => {
    const project = dir("c");
    put(project, ".ox/skills/no-front/SKILL.md", "直接写正文，没有 front matter");
    put(project, ".ox/skills/no-desc/SKILL.md", ["---", "name: no-desc", "---", "", "正文"].join("\n"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills).toEqual([]);
    expect(res.issues).toHaveLength(2);
    // 按路径取，不按下标（遍历是目录名字典序，下标会随目录名变化）。
    const byPath = (p: string) => res.issues.find((i) => i.path === p);
    expect(byPath(".ox/skills/no-front/SKILL.md")?.reason).toMatch(/front matter/);
    expect(byPath(".ox/skills/no-desc/SKILL.md")?.reason).toMatch(/description/);
  });

  it("项目级压过全局级（反了就是「改了没用」）", () => {
    const project = dir("d");
    const global = dir("d2");
    put(project, ".ox/skills/ship-it/SKILL.md", doc("ship-it", "项目里特有的上线流程"));
    put(global, "ship-it/SKILL.md", doc("ship-it", "全局默认的上线流程"));
    const res = readSkills([
      { origin: "global", rootAbs: global },
      { origin: "project", rootAbs: path.join(project, ".ox", "skills") },
    ]);
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0]?.origin).toBe("project");
    expect(res.skills[0]?.description).toBe("项目里特有的上线流程");
    // 路径也跟着换成生效的那份。
    expect(res.skills[0]?.path).toBe(".ox/skills/ship-it/SKILL.md");
  });

  it(".disabled 只是停用，仍然列出来（删掉才是不在列表里）", () => {
    const project = dir("e");
    put(project, ".ox/skills/paused/SKILL.md", doc("paused", "暂不启用"));
    put(project, ".ox/skills/paused/.disabled", "");
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0]?.enabled).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it("超大的 SKILL.md 判坏（不把整份文件读进提示）", () => {
    const project = dir("f");
    put(project, ".ox/skills/huge/SKILL.md", doc("huge", "很大", "x".repeat(300 * 1024)));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills).toEqual([]);
    expect(res.issues[0]?.reason).toMatch(/过大/);
  });

  it("来源顺序不影响最终排序（按名字排），但覆盖方向由 origin 决定", () => {
    const project = dir("g");
    const global = dir("g2");
    put(project, ".ox/skills/beta/SKILL.md", doc("beta", "项目版"));
    put(global, "alpha/SKILL.md", doc("alpha", "全局版"));
    const res = readSkills([
      { origin: "global", rootAbs: global },
      { origin: "project", rootAbs: path.join(project, ".ox", "skills") },
    ]);
    expect(res.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });
});
