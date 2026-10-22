import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readJsonFile, writeFileAtomic } from "../atomic-file";
import {
  normalizeAutomation,
  normalizeAutomationInput,
  type Automation,
  type AutomationFields,
} from "../../shared/automation";

/**
 * 桌面自动化（M5b）的记录仓：一个 JSON 文件、原子落盘、坏记录逐条跳过。
 *
 * 为什么是单文件而不是 `session-store` 的一条一会话：automation 是几十字节的
 * 小记录，界面要的是整表（列表/启停/改间隔），没有"单条大正文按 id 取"的场景。
 * 与 `session-store` 保持一致的失败语义：
 * - **坏记录跳过**（`normalizeAutomation` 返 null 的不进列表），其它照常列出；
 * - **写失败抛给宿主**（IPC 记一条日志），不静默假装已保存；
 * - **文件损坏让 `readJsonFile` 抛出来**（同 `ProjectStore`）：静默当空表会让
 *   "我的自动化全没了"没有任何痕迹，喊出来才能被当成事故处理。
 */

export const AUTOMATION_STORE_VERSION = 1;

/** id 形如 `auto-<uuid>`；前缀让人在审计/日志里一眼认出这是自动化的触发。 */
const ID_PREFIX = "auto-";

interface AutomationFile {
  version: typeof AUTOMATION_STORE_VERSION;
  automations: Automation[];
}

export interface AutomationUpdate {
  name?: string;
  projectId?: string;
  everyMs?: number;
  enabled?: boolean;
}

export class AutomationStore {
  private readonly filePath: string;

  constructor(rootAbs: string) {
    this.filePath = path.join(path.resolve(rootAbs), "automations.json");
  }

  /** 全部自动化（坏记录跳过）。文件缺失 = 空表；文件损坏 = 抛给调用方。 */
  list(): Automation[] {
    const parsed = readJsonFile<unknown>(this.filePath, undefined);
    if (parsed === undefined) return [];
    const arr = (parsed as Partial<AutomationFile> | null)?.automations;
    if (!Array.isArray(arr)) return [];
    const out: Automation[] = [];
    for (const raw of arr) {
      const a = normalizeAutomation(raw, Date.now());
      if (a) out.push(a);
    }
    return out;
  }

  get(id: string): Automation | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  /**
   * 新建。入参与读盘共用 `normalizeAutomationInput` 这把尺子（M5b 纪律 3）：
   * 这里放行的写法，下次启动读盘时也必须放行。
   */
  create(input: Partial<AutomationFields> & { enabled?: boolean }, now: number): Automation {
    const checked = normalizeAutomationInput(input);
    if ("error" in checked) throw new Error(checked.error);
    const record: Automation = {
      id: `${ID_PREFIX}${randomUUID()}`,
      ...checked.input,
      enabled: input.enabled === true,
      createdAt: now,
      updatedAt: now,
    };
    const all = this.list();
    all.push(record);
    this.writeAll(all);
    return record;
  }

  /**
   * 更新可编辑字段。合并后**重新过一遍尺子**（不是只校验传来的字段）——
   * 逐个字段打补丁会把"500ms 间隔 + 改名"这种组合放过去，而合并后校验不会。
   * 返回 null = 没有这个 id。
   */
  update(id: string, patch: AutomationUpdate, now: number): Automation | null {
    const all = this.list();
    const idx = all.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const current = all[idx]!;
    const merged: Automation = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.everyMs !== undefined ? { everyMs: patch.everyMs } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
      updatedAt: now,
    };
    // 合并结果也要过尺子：改出来的坏值（空名/低于下限的间隔）当场拒收，
    // 不留到下次启动才被发现。
    const checked = normalizeAutomationInput(merged);
    if ("error" in checked) throw new Error(checked.error);
    // 三个用户字段取**归一化后**的值（trim / 截断），id 与创建时间不属于可编辑范围。
    const next: Automation = {
      ...merged,
      ...checked.input,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    all[idx] = next;
    this.writeAll(all);
    return all[idx]!;
  }

  remove(id: string): boolean {
    const all = this.list();
    const rest = all.filter((a) => a.id !== id);
    if (rest.length === all.length) return false;
    this.writeAll(rest);
    return true;
  }

  /**
   * 记一次**真正启动**的时间戳（调度器在用）。写失败照样抛 —— 但调度器侧
   * 会接住并记账：触发已经发生，不能因为账本写不下去就当作没触发。
   */
  markFired(id: string, now: number): Automation | null {
    const all = this.list();
    const idx = all.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx]!, lastFiredMs: now, updatedAt: now };
    this.writeAll(all);
    return all[idx]!;
  }

  private writeAll(records: Automation[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 原子落盘：就地截断的写死在半路会把整表 automation 清零（不可恢复）。
    writeFileAtomic(this.filePath, JSON.stringify({ version: AUTOMATION_STORE_VERSION, automations: records }, null, 2));
  }
}
