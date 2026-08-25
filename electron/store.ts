import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";

interface ProjectRecord {
  id: string;
  name: string;
  requirement: string;
  stage: string;
  prdJson?: string;
  batchesJson?: string;
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
    if (!fs.existsSync(this.file)) return [];
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as ProjectRecord[];
  }

  private writeAll(records: ProjectRecord[]): void {
    fs.writeFileSync(this.file, JSON.stringify(records, null, 2), "utf8");
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
}

export class SettingsStore {
  constructor(private file: string) {}

  load(): ProjectSettings {
    if (!fs.existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<ProjectSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  }

  save(settings: ProjectSettings): void {
    fs.writeFileSync(this.file, JSON.stringify(settings, null, 2), "utf8");
  }
}
