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

  it("普通文件混在技能目录里挡不住扫描（扫的是目录，杂散文件排在谁前面都一样）", () => {
    // 目录遍历按名字排序，杂散文件（README、笔记、IDE 垃圾）落在任何位置都
    // 只该跳过它自己。目录扫描在它那里停下来的话，排在后面的技能会整批
    // 无声消失 —— 技能页与提示都看不出少了东西，只会觉得「技能没生效」。
    const project = dir("b2");
    put(project, ".ox/skills/aaa-notes.txt", "这不是技能目录");
    put(project, ".ox/skills/zz-ship/SKILL.md", doc("zz-ship", "上线流程"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills.map((s) => s.name)).toEqual(["zz-ship"]);
    expect(res.issues).toEqual([]);
  });

  it("没有 SKILL.md 的目录挡不住后面的技能（脚本/资源目录是常态，不该连坐）", () => {
    const project = dir("b3");
    put(project, ".ox/skills/aaa-helper/run.sh", "echo hi");
    put(project, ".ox/skills/zz-ship/SKILL.md", doc("zz-ship", "上线流程"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills.map((s) => s.name)).toEqual(["zz-ship"]);
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

  it("超大技能只连坐它自己：进 issues，但后面的技能照常扫出来", () => {
    // 判坏的影响面必须是「它自己那一格」：一份超大文件把整个目录扫描顶掉的话，
    // 用户看到的是「所有技能都没了」，而真实原因（那一份超了上限）反而被藏住。
    const project = dir("f2");
    put(project, ".ox/skills/aaa-huge/SKILL.md", doc("aaa-huge", "很大", "x".repeat(300 * 1024)));
    put(project, ".ox/skills/zz-ship/SKILL.md", doc("zz-ship", "上线流程"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.issues.map((i) => i.path)).toEqual([".ox/skills/aaa-huge/SKILL.md"]);
    expect(res.skills.map((s) => s.name)).toEqual(["zz-ship"]);
  });

  it("SKILL.md 是个目录而不是文件时只报那一条，后面的技能照常扫出来", () => {
    // `statSync` 对目录照样给出 size（过得了上限检查），真正炸的是 `readFileSync`
    // —— 这个形态只有「读失败」这一档能接住，且影响面同样只许是它自己那一格。
    const project = dir("f3");
    put(project, ".ox/skills/aaa-odd/SKILL.md/inner.txt", "这使 SKILL.md 成为目录");
    put(project, ".ox/skills/zz-ship/SKILL.md", doc("zz-ship", "上线流程"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills.map((s) => s.name)).toEqual(["zz-ship"]);
    expect(res.issues.map((i) => i.path)).toEqual([".ox/skills/aaa-odd/SKILL.md"]);
    expect(res.issues[0]?.reason).toMatch(/读取失败/);
  });

  it("同一层里重名时字典序在前的赢（扫描顺序钉死，重名取舍才可复现）", () => {
    // 目录遍历的顺序不是文件系统给的（readdir 无序），这里排成字典序正是
    // 「同名时先扫到的赢」可复现的前提 —— 顺序反过来，赢家就换成另一个目录，
    // 用户改了 aaa 那份却一直读 zzz 那份，「改了没用」无从排查。
    const project = dir("f4");
    put(project, ".ox/skills/aaa-dir/SKILL.md", doc("dup", "甲"));
    put(project, ".ox/skills/zzz-dir/SKILL.md", doc("dup", "乙"));
    const res = readSkills([{ origin: "project", rootAbs: path.join(project, ".ox", "skills") }]);
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0]?.description).toBe("甲");
    expect(res.skills[0]?.path).toBe(".ox/skills/aaa-dir/SKILL.md");
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
