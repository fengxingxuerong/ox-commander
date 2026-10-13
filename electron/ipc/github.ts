/**
 * GitHub 只读通道（摄入半边，2026-10-14）。
 *
 * 给桌面的"从 issue 建任务"选择器供数。**只有一条通道**：列 issue。
 * 单条 issue 的解析发生在 headless 的 runner 里（spec.issue），桌面端直接
 * 拿列表里那一条的标题+正文建项目，不需要再打一次 IPC。
 *
 * 命令白名单、字符集校验与超时都在 `../context/github-readonly.ts`，本文件
 * 只做**入参形状校验** —— 渲染层传来的 repo/search 是不可信输入，与 P0-3
 * 给 settings:save 补的校验同一条规矩：控制面写入口（这里是触发外部命令的
 * 入口）不能直落。
 */
import { ipcMain } from "electron";
import { REPO_RE, listGithubIssues } from "../context/github-readonly";

/** 选择器的拉取入参（三个字段都可缺席：留空 = gh 按 cwd 认仓库、拉开放的）。 */
export interface ListIssuesInput {
  repo?: string;
  search?: string;
  limit?: number;
}

export function registerGithubHandlers(): void {
  ipcMain.handle("github:list-issues", (_e, input: unknown) => {
    const o: Record<string, unknown> =
      input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const repo = o["repo"];
    const search = o["search"];
    const limit = o["limit"];
    if (repo !== undefined && (typeof repo !== "string" || !REPO_RE.test(repo))) {
      throw new Error("repo 必须是 owner/repo 形态（或省略）");
    }
    if (search !== undefined && typeof search !== "string") {
      throw new Error("search 必须是字符串");
    }
    if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error("limit 必须是正整数");
    }
    const query: ListIssuesInput = {
      ...(repo !== undefined ? { repo } : {}),
      ...(search !== undefined ? { search } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    // gh 没装/没登录/仓库不存在：折进结果对象的 reason，由选择器摆出来 ——
    // "没拿到"和"没有 issue"是两件事，抛异常会把前者显示成后者。
    return listGithubIssues(query);
  });
}
