import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";
import { readJsonFile, writeFileAtomic } from "./atomic-file";

interface ProjectRecord {
  id: string;
  name: string;
  requirement: string;
  stage: string;
  prdJson?: string;
  batchesJson?: string;
  /** 规划期生成的独立样本冒烟清单（SmokeCheck[]），与 batchesJson 同生共死。 */
  smokeJson?: string;
  createdAt: string;
  updatedAt: string;
}

/** JSON-file persistence under userData; swap for SQLite without touching callers. */
export class ProjectStore {
  constructor(private dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  private get file(): string {
    return path.join(this.dataDir, "projects.json");
  }

  private readAll(): ProjectRecord[] {
    return readJsonFile<ProjectRecord[]>(this.file, []);
  }

  private writeAll(records: ProjectRecord[]): void {
    // Atomic on purpose: an in-place truncate that dies half-way loses every
    // project record, which is unrecoverable from the UI.
    writeFileAtomic(this.file, JSON.stringify(records, null, 2));
  }

  create(name: string, requirement: string): ProjectRecord {
    const rec: ProjectRecord = {
      id: `p-${Date.now()}`,
      name,
      requirement,
      stage: "PRD",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const all = this.readAll();
    all.push(rec);
    this.writeAll(all);
    return rec;
  }

  list(): ProjectRecord[] {
    return this.readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<Omit<ProjectRecord, "id" | "createdAt">>): void {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`project ${id} not found`);
    all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    this.writeAll(all);
  }

  get(id: string): ProjectRecord | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  /** Removes the record; returns true when it existed. */
  remove(id: string): boolean {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    this.writeAll(all);
    return true;
  }
}

export class SettingsStore {
  constructor(private file: string) {}

  load(): ProjectSettings {
    if (!fs.existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS);
    const parsed = readJsonFile<Partial<ProjectSettings>>(this.file, {});
    // Clone the defaults so nested arrays (verificationCommands / enabledAgents /
    // llmPool) are never shared with DEFAULT_SETTINGS: a caller mutating the
    // loaded settings in place must not be able to poison process-wide defaults.
    return { ...structuredClone(DEFAULT_SETTINGS), ...parsed };
  }

  save(settings: ProjectSettings): void {
    // Atomic: a truncated settings.json silently resets the operator's whole
    // configuration on next launch, including their LLM pool.
    writeFileAtomic(this.file, JSON.stringify(settings, null, 2));
  }
}
