import fs from "node:fs";
import path from "node:path";
import {
  FileJournal,
  isInsideZone,
  type FileChange,
  type JournalToken,
} from "../sandbox/file-journal";
import { SnapshotStore, type SnapshotToken } from "../sandbox/snapshot-store";

/**
 * 变体隔离的工作单位（B4）：一次"派发 → 捕获 → 复位"的现场。
 *
 * 两个底层原语各管一半，缺一不可：
 *   · `SnapshotStore` 提供 zone 内文件的**派发前备份** —— 复位（`revert`）
 *     与赢家回放（`apply`）都要读它；
 *   · `FileJournal` 回答"这一变体到底动了哪些文件" —— 前向镜像只按实际
 *     变更走，不做整目录复制。
 *
 * 备份目录挂在与 BatchGuard 同一个 `backupRoot` 下，`runId` 由调用方保证
 * 全局唯一（快照目录名直接取它）；`finish()` 在裁决结束后把整目录丢弃 ——
 * 变体窗口是瞬态的，只有赢家写下的文件才该活到批次存档那一步。
 */
export interface VariantWindow {
  /** 唯一 id（进快照目录名；同毫秒连开两窗也不会撞）。 */
  id: string;
  rootAbs: string;
  zone: string;
  /** zone 内文件的派发前备份。 */
  token: SnapshotToken;
  /** 全根变更台账（`capture` 时按 zone 过滤，见下）。 */
  journal: JournalToken;
}

/**
 * 一次变体派发的产物：变了什么 + 变后内容（前向镜像）。
 *
 * `forward` 的 key 是任务 zone 内的相对 posix 路径，值是**变体写下的内容**；
 * `null` 表示该变体删除了这个文件（回放时对应执行删除）。
 */
export interface VariantCapture {
  variantIndex: number;
  agentId?: string;
  changes: FileChange[];
  forward: Map<string, Buffer | null>;
  /**
   * 镜像是否可回放。false = 至少一个变更文件在捕获时读不出来 —— 此时
   * **不回退该窗口**（保留现场）并由调度层中止后续变体：已经写下的东西还原
   * 不了，硬还原只会把执行器的交付弄丢。宁可降级成"单派发 + 现场保留"。
   */
  replayable: boolean;
  /** replayable=false 的原因（进 logDigest）。 */
  note?: string;
}

/**
 * 变体窗口的动作面：调度器只依赖这五个动作，测试可注入内存替身。
 * 生产实现 = `VariantStore`（快照 + 台账组装）。
 */
export interface VariantBackend {
  beginWindow(opts: { runId: string; root: string; zone: string }): Promise<VariantWindow>;
  capture(win: VariantWindow, meta: { variantIndex: number; agentId?: string }): VariantCapture;
  revert(win: VariantWindow): Promise<void>;
  apply(win: VariantWindow, capture: VariantCapture): void;
  finish(win: VariantWindow): Promise<void>;
}

export class VariantStore implements VariantBackend {
  constructor(
    private readonly snapshots: SnapshotStore,
    /**
     * 默认全根监听：`changed()` 会看到 zone 外的一切，但 `capture()` 只取
     * zone 内的条目 —— 同批任务的 zone 两两不相交（`runBatch` 的批内重叠
     * 检查保证），过滤之后每个窗口只装自己任务的东西，并发窗口互不污染。
     */
    private readonly journal: FileJournal = new FileJournal(),
  ) {}

  /** 开窗：zone 内文件全量备份 + 全根变更基线。 */
  async beginWindow(opts: { runId: string; root: string; zone: string }): Promise<VariantWindow> {
    const token = await this.snapshots.begin({
      runId: opts.runId,
      root: opts.root,
      zones: [opts.zone],
      include: [],
    });
    const journal = this.journal.begin(opts.root, [opts.zone], opts.runId);
    return { id: opts.runId, rootAbs: token.rootAbs, zone: opts.zone, token, journal };
  }

  /** 捕获：zone 内净变更 + 变更后内容。调用时文件还在（回退之前）。 */
  capture(win: VariantWindow, meta: { variantIndex: number; agentId?: string }): VariantCapture {
    const changes = this.journal
      .changed(win.journal)
      .filter((c) => isInsideZone(c.path, win.zone));
    const forward = new Map<string, Buffer | null>();
    for (const c of changes) {
      if (c.op === "delete") {
        forward.set(c.path, null);
        continue;
      }
      try {
        forward.set(c.path, fs.readFileSync(path.join(win.rootAbs, c.path)));
      } catch (err) {
        // 读不出来的变更文件 = 回放时写不回去：整窗判为不可回放，保留现场。
        return {
          variantIndex: meta.variantIndex,
          agentId: meta.agentId,
          changes,
          forward,
          replayable: false,
          note: `${c.path}（${(err as Error).message}）`,
        };
      }
    }
    return {
      variantIndex: meta.variantIndex,
      agentId: meta.agentId,
      changes,
      forward,
      replayable: true,
    };
  }

  /**
   * 复位到开窗时：无选择器回退（`SnapshotStore` 的整窗语义）——
   * zone 内被备份的文件逐一还原、zone 内新建且无备份的文件删除。
   * zone 外的任何改动不归本窗口管（那是 BatchGuard 的账）。
   */
  async revert(win: VariantWindow): Promise<void> {
    await this.snapshots.revert(win.token);
  }

  /** 回放：把一次捕获的内容原样落到盘上（裁决出的赢家专用）。 */
  apply(win: VariantWindow, capture: VariantCapture): void {
    for (const [rel, content] of capture.forward) {
      const abs = path.join(win.rootAbs, rel);
      if (content === null) {
        fs.rmSync(abs, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  /** 丢弃该窗口的备份目录（裁决结束后调用；此后 revert/apply 不再可用）。 */
  async finish(win: VariantWindow): Promise<void> {
    await this.snapshots.commit(win.token);
  }
}
