/**
 * 技能（M6a）的桌面 IPC。
 *
 * 只有一个通道（`skills:list`），而且**只读**：技能的创建/编辑本轮仍在文件里
 * （`.ox/skills/<name>/SKILL.md`），写盘由人或未来的技能编辑器负责。
 *
 * 为什么不做 `skills:create` 而现在：技能的内容是"教模型怎么做一件事"，它不
 * 该在界面上被当成一个表单字段填两行就生成 —— Codex 自己的获取方式里最有效
 * 的也是"演示一遍生成 SKILL.md"（Record & Replay，蓝图里列为「可做」档）。
 * 与其先做一个能产出空技能的表单，不如先让已有的技能真的进得了会话。
 *
 * 失败语义沿用 automations 那一套：读盘出问题**不抛**给界面，而是把问题带回
 * 去 —— 抛出去的结果是技能页变成一块错误屏，而"扫不到"本身不是致命错误。
 */
import { app, ipcMain } from "electron";
import path from "node:path";

import { readSkills, type SkillSource } from "../engine/skills";
import { logLine, workspaceRoot } from "./context";
import type { Skill, SkillIssue } from "../../shared/skills";

/** 全局技能目录：`~/.ox/skills`（与全局约定的位置同层）。 */
function globalSkillsRoot(): string {
  return path.join(app.getPath("home"), ".ox", "skills");
}

export interface SkillListResult {
  skills: Skill[];
  issues: SkillIssue[];
  /** 扫描本身出问题时带上（界面照常显示技能，只是多一句解释）。 */
  problem?: string;
}

export function readSkillList(projectId?: string): SkillListResult {
  const sources: SkillSource[] = [{ origin: "global", rootAbs: globalSkillsRoot() }];
  if (projectId !== undefined && projectId.trim() !== "") {
    sources.push({ origin: "project", rootAbs: path.join(workspaceRoot(projectId), ".ox", "skills") });
  }
  try {
    const res = readSkills(sources);
    return { skills: res.skills, issues: res.issues };
  } catch (err) {
    const problem = (err as Error).message;
    logLine(`[skill] 技能目录扫描失败：${problem}`);
    return { skills: [], issues: [], problem };
  }
}

export function registerSkillHandlers(): void {
  ipcMain.handle("skills:list", (_e, input: unknown) => {
    const payload = (input ?? {}) as { projectId?: unknown };
    // projectId 是可选的：没选项目时只列全局技能，而不是报错 ——
    // 技能页在"还没打开项目"时也要能看一眼有哪些技能。
    const projectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
    return readSkillList(projectId);
  });
}
