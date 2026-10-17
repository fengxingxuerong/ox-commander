/**
 * Agent pool: listing, manifest example, runtime register/unregister, enable/
 * toggle and probe. Plus the observability channels (breaker stats + audit).
 *
 * Registration only — all state lives in `./context`.
 */
import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  buildAdaptersFromManifests,
  removeManifestFile,
  saveManifestFile,
} from "../agents/manifest-loader";
import { exampleManifest, parseAgentManifest } from "../agents/manifest-schema";
import { taskTrail } from "../board-derive";
import { diffText } from "../../shared/text-diff";
import type { AgentDescriptor } from "../../shared/agent-contract";
import {
  agentDir,
  dynamicAgentMap,
  ensureAgentLayer,
  ensureAudit,
  promptDir,
  settingsStore,
} from "./context";

/** Serializable view of a registry entry for the renderer (never leaks credentials). */
function describeAgent(d: AgentDescriptor) {
  return {
    id: d.manifest.id,
    displayName: d.manifest.displayName,
    adapter: d.manifest.adapter,
    source: d.manifest.source ?? "builtin",
    enabled: d.enabled,
    inferredLegacy: d.inferredLegacy,
    priority: d.priority,
    capabilities: d.capabilities,
    limits: d.limits,
    credentialKind: d.manifest.credential?.kind ?? "none",
  };
}

/**
 * `changes:file` / `changes:revert` 的请求形状与路径校验。
 *
 * 路径防穿越在这里做第一道：renderer 传来的 `path` 会拼进工作区绝对路径，
 * `..` 段或绝对路径必须在此拦下（SnapshotStore 内部还有第二道，双保险）。
 * batchId 限定 `[\w.-]` —— 它最终成为存档目录名的一部分。
 */
function parseFileRequest(input: unknown): { batchId: string; path: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const { batchId, path: rel } = input as { batchId?: unknown; path?: unknown };
  if (typeof batchId !== "string" || !/^[\w.-]+$/.test(batchId)) return null;
  if (typeof rel !== "string") return null;
  const norm = rel.replace(/\\/g, "/").replace(/^\.\/+/, "");
  // 绝对路径**拒绝**而不是洗成相对：`/etc/passwd` 洗成 `etc/passwd` 后虽然
  // 只会拼到工作区底下（读不到真系统文件），但"洗白"本身会让调用方以为
  // 它传的路径被接受了。上级目录段同理。SnapshotStore 内还有第二道。
  if (norm === "" || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm) || norm.split("/").includes("..")) {
    return null;
  }
  return { batchId, path: norm };
}

/**
 * 审计证据：这个文件是不是该批 `create` 的（单文件回滚删除分支的许可）。
 *
 * 读 `batch-changes` 记录的 `files` 清单（写入方自截 100 条）—— 超出截断
 * 的文件拿不到证据，那时调用方按"无证据"保守处理。
 */
function wasCreatedByBatch(batchId: string, rel: string): boolean {
  for (const r of ensureAudit().read({ phase: "batch-changes", limit: 1000 })) {
    if (r.archiveId !== batchId) continue;
    const hit = r.files?.find((f) => f.path === rel);
    return hit?.op === "create";
  }
  return false;
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agents:list", () => {
    const layer = ensureAgentLayer(settingsStore().load());
    return {
      agents: layer.registry.list().map(describeAgent),
      manifestDir: agentDir(),
      manifestErrors: layer.manifestErrors,
      skippedManifests: layer.skippedManifests,
    };
  });

  ipcMain.handle("agents:example-manifest", () => exampleManifest());

  ipcMain.handle("agents:register", (_e, raw: unknown) => {
    const settings = settingsStore().load();
    const manifest = parseAgentManifest(raw); // throws ManifestValidationError with all issues
    const layer = ensureAgentLayer(settings);
    const dynamic = dynamicAgentMap();
    if (layer.registry.has(manifest.id) && !dynamic.has(manifest.id)) {
      return {
        ok: false,
        error: `agent id "${manifest.id}" 已被内置或 agents.d 声明占用（内置适配器优先）`,
      };
    }
    const built = buildAdaptersFromManifests([manifest], { promptDir: promptDir() });
    if (built.adapters.length === 0) {
      return { ok: false, error: built.skipped[0]?.reason ?? "无法从该 manifest 构建适配器" };
    }
    const adapter = built.adapters[0]!;
    const res = layer.registry.register({ adapter, manifest });
    if (!res.ok) return res;
    dynamic.set(manifest.id, { adapter, manifest });
    // 写回 agents.d：注册只进内存的话，重启（或崩溃）就没了。
    // 落盘失败**不**回滚注册 —— 这一轮的 agent 确实能用，但必须如实报上去，
    // 否则用户以为"记住了"，下次开机才发现没了。
    const saved = saveManifestFile(agentDir(), manifest);
    ensureAudit().append({
      phase: "agent-change",
      agentId: manifest.id,
      detail: `register（${manifest.adapter}）${res.replaced ? "覆盖原注册" : ""}${
        saved.ok ? "已落盘" : `落盘失败：${saved.reason ?? "未知原因"}`
      }`,
    });
    return {
      ok: true,
      id: manifest.id,
      replaced: res.replaced,
      persisted: saved.ok ? { ok: true, path: saved.path! } : { ok: false, reason: saved.reason },
    };
  });

  ipcMain.handle("agents:unregister", async (_e, id: string, graceMs?: number) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const res = await layer.registry.unregister(id, graceMs !== undefined ? { graceMs } : {});
    if (res.ok) {
      const registered = dynamicAgentMap().get(id);
      dynamicAgentMap().delete(id);
      // 顺手删掉当初写下的那份文件，否则"注销"只在本轮生效、重启它又回来了。
      // 找不到当初的 manifest（比如是内置/agents.d 加载的）就只改内存。
      const removed = registered
        ? removeManifestFile(agentDir(), registered.manifest)
        : { ok: true as const, removed: false };
      ensureAudit().append({
        phase: "agent-change",
        agentId: id,
        detail: `unregister（drain: ${res.drained}）${
          removed.removed ? "已删除 agents.d 中的文件" : removed.reason ? `（${removed.reason}）` : ""
        }`,
      });
      return { ...res, persisted: removed };
    }
    return res;
  });

  ipcMain.handle("agents:toggle", (_e, id: string, enabled: boolean) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const ok = layer.registry.setEnabled(id, enabled);
    if (ok) ensureAudit().append({ phase: "agent-change", agentId: id, detail: enabled ? "enabled" : "disabled" });
    return ok;
  });

  ipcMain.handle("agents:probe", async (_e, id?: string) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const targets = id
      ? [layer.registry.get(id)].filter((d): d is NonNullable<typeof d> => d !== undefined)
      : layer.registry.list();
    const results: Record<string, boolean> = {};
    await Promise.all(
      targets.map(async (d) => {
        results[d.manifest.id] = await d.adapter.probe().catch(() => false);
      }),
    );
    return results;
  });
}

export function registerObservabilityHandlers(): void {
  ipcMain.handle("agents:stats", () => {
    const layer = ensureAgentLayer(settingsStore().load());
    return { circuits: layer.breaker.snapshot() };
  });

  /** Recent audit records, newest last. */
  ipcMain.handle("audit:recent", (_e, limit?: number) => {
    return ensureAudit().read({ limit: Math.max(1, Math.min(limit ?? 100, 1000)) });
  });

  /**
   * 一个任务的运行履历（P1-3 上下文回溯）：每次派发谁跑的、多久、为什么失败。
   * 派生规则在纯函数 `taskTrail` 里 —— 宿主只负责把事实喂进去。
   */
  ipcMain.handle("audit:trail", (_e, taskId?: string) => {
    if (typeof taskId !== "string" || taskId === "") return { taskId: "", runs: [] };
    return taskTrail(ensureAudit().read({ limit: 5000 }), taskId);
  });

  ipcMain.handle("audit:files", () => ensureAudit().files().map((f) => path.basename(f)));

  /**
   * 批次改动事实（diff 面板供数，B1）：读 `batch-changes` 审计，按项目过滤，
   * 最新批次在前。带 `archiveId` 的批次另有 `changes:file`（逐行 diff）与
   * `changes:revert`（单文件回滚）两个入口 —— 它们的可用性取决于那批备份是否
   * 还在存档里（容量策略只保留最近 8 批）；没有存档的批次，界面不显示按钮。
   */
  ipcMain.handle("changes:list", (_e, projectId?: string) => {
    const records = ensureAudit().read({ phase: "batch-changes", limit: 1000 });
    // 两步判而不是 `typeof === "string" && projectId !== ""`：site 审计曾在这里
    // 抓到一个真存活 —— `&&` 换 `||` 后，无参调用会掉进 filter 分支把"没有
    // projectId 的记录"当成"这个项目的"，而当时的用例恰好全部无 projectId，
    // 两个分支结果相同，断言杀不掉它。拆成两步后每一支都有独立断言盯着。
    const wanted = typeof projectId === "string" ? projectId : "";
    const mine = wanted === "" ? records : records.filter((r) => r.projectId === wanted);
    return mine.slice(-50).reverse();
  });

  /**
   * 逐行 diff（B1 第二半）：存档里的 before × 盘上的 after。
   *
   * before 的三种缺席要分开说：文件在存档的 `files` 里但内容读不出来 = 真
   * 失败；不在 `files` 里 = 本批新建（没有 before）—— 后者是正常形态，
   * diff 会以 `created` 呈现，不是错误。
   */
  ipcMain.handle("changes:file", (_e, input: unknown) => {
    const req = parseFileRequest(input);
    if (req === null) return { ok: false as const, reason: "请求形状不对（要 { batchId, path }）" };
    const layer = ensureAgentLayer(settingsStore().load());
    const store = layer.snapshots;
    if (!store) return { ok: false as const, reason: "未配置快照存储，这一批没有存档可看" };
    const record = store.listArchives().find((a) => a.id === req.batchId);
    if (!record) return { ok: false as const, reason: "存档不存在（可能已被容量策略回收）" };

    let before: string | undefined;
    if (record.files.includes(req.path)) {
      const content = store.readArchived(req.batchId, req.path);
      if (content === null) return { ok: false as const, reason: "存档内容读不出来（备份损坏或被清掉）" };
      before = content;
    }
    // after：盘上现状。读不到 = 文件已不在（删除后没恢复），按 undefined 交给
    // diffText 以 `deleted` 呈现 —— 与"文件是空的"是两回事，不能混。
    let after: string | undefined;
    try {
      after = fs.readFileSync(path.join(record.rootAbs, req.path), "utf8");
    } catch {
      after = undefined;
    }
    return { ok: true as const, diff: diffText(before, after) };
  });

  /**
   * 单文件回滚（B1 第二半）：从存档恢复 before；本批新建的文件撤销新建。
   *
   * 删除分支的"新建证据"来自审计：该批 `batch-changes` 记录里这个文件的
   * op 必须是 `create`。证据缺席（files 截断没带上它 / 记录已轮转）时
   * 保守拒绝 —— 与 SnapshotStore.revert 的同一条纪律：宁可留一个脏文件，
   * 不删错一个既有文件。
   */
  ipcMain.handle("changes:revert", (_e, input: unknown) => {
    const req = parseFileRequest(input);
    if (req === null) return { ok: false as const, reason: "请求形状不对（要 { batchId, path }）" };
    const layer = ensureAgentLayer(settingsStore().load());
    const store = layer.snapshots;
    if (!store) return { ok: false as const, reason: "未配置快照存储，无法回滚" };
    if (!store.hasArchive(req.batchId)) {
      return { ok: false as const, reason: "存档不存在（可能已被容量策略回收）" };
    }
    const created = wasCreatedByBatch(req.batchId, req.path);
    if (!created && !store.hasBackupFor(req.batchId, req.path)) {
      // 没有备份、又没有新建证据：这正是"可能是既有文件"的形态，拒绝动手。
      return { ok: false as const, reason: "无备份、也没有本批新建的证据：这可能是既有文件，不删" };
    }
    return store.restoreArchived(req.batchId, req.path, created);
  });

  /**
   * Export the whole audit history to a file the user picks in a save dialog.
   *
   * The renderer never names a path: the dialog *is* the authorization, so no
   * path whitelist is needed here. Outcomes are reported as data (ok/reason)
   * instead of throwing, because "canceled" is not an error and the operator
   * must be able to tell it apart from "nothing exported".
   */
  ipcMain.handle("audit:export", async () => {
    const files = ensureAudit().files();
    if (files.length === 0) return { ok: false as const, reason: "empty" };
    const picked = await dialog.showSaveDialog({
      title: "导出审计日志（JSONL）",
      defaultPath: `ox-audit-export-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false as const, reason: "canceled" };
    try {
      const saved = ensureAudit().exportTo(picked.filePath);
      ensureAudit().append({ phase: "settings", detail: `审计日志已导出到 ${saved}` });
      return { ok: true as const, path: saved };
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });
}
