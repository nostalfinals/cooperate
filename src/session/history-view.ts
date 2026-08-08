import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { buildSessionTree, type SubagentHistory } from "./history.ts";
import type { SessionStore } from "./types.ts";
import type { SubagentSnapshot } from "../subagent/types.ts";

/** Read-only view and lazy tree cache for completed subagent history. */
export class SubagentHistoryView {
  private readonly history?: SubagentHistory;
  private readonly store: SessionStore;
  private readonly historyTrees = new Map<string, readonly SessionTreeNode[]>();

  constructor(history: SubagentHistory | undefined, store: SessionStore) {
    this.history = history;
    this.store = store;
  }

  roots(): readonly SubagentSnapshot[] {
    return this.history?.roots() ?? [];
  }

  record(subagentId: string): { snapshot: SubagentSnapshot; result?: string } | undefined {
    const record = this.history?.record(subagentId);
    if (record) return { snapshot: record.snapshot, result: record.result };
    // Nested runs have no sidecar record of their own; fall back to the
    // recursive snapshot carried inside a top-level record.
    const snapshot = this.history?.snapshot(subagentId);
    if (!snapshot) return undefined;
    return { snapshot };
  }

  /** Synchronous cache read; kicks off a background load when the tree is not cached yet. */
  tree(subagentId: string): readonly SessionTreeNode[] | undefined {
    const cached = this.historyTrees.get(subagentId);
    if (cached) return cached;
    if (!this.historyTreeTarget(subagentId)) return undefined;
    void this.loadTree(subagentId);
    return undefined;
  }

  /** Load (and cache) the truncated tree of a historical subagent session. */
  async loadTree(subagentId: string): Promise<readonly SessionTreeNode[] | undefined> {
    const cached = this.historyTrees.get(subagentId);
    if (cached) return cached;
    const target = this.historyTreeTarget(subagentId);
    if (!target) return undefined;
    try {
      const opened = await this.store.open(target.sessionId);
      const native = opened.native as { getEntries(): readonly SessionEntry[] } | undefined;
      if (!native) return undefined;
      // Both top-level records and nested boundaries truncate to the run's
      // completion entry count; only boundary-less legacy snapshots show the
      // full session file.
      const entries = target.endCount >= 0
        ? native.getEntries().slice(0, target.endCount)
        : native.getEntries();
      const tree = buildSessionTree(entries);
      this.historyTrees.set(subagentId, tree);
      return tree;
    } catch {
      return undefined;
    }
  }

  /** Drop a cached history tree (called when the panel leaves the detail view). */
  releaseTree(subagentId: string): void {
    this.historyTrees.delete(subagentId);
  }

  /** Locate the session backing a historical subagent, top-level or nested. */
  private historyTreeTarget(subagentId: string): { sessionId: string; endCount: number } | undefined {
    const record = this.history?.record(subagentId);
    if (record) return { sessionId: record.sessionId, endCount: record.endCount };
    const boundary = this.history?.boundary(subagentId);
    if (boundary) return { sessionId: boundary.sessionId, endCount: boundary.endCount };
    // Fallback for records written before nested boundaries existed: show the
    // full session file since no completion boundary is known.
    const snapshot = this.history?.snapshot(subagentId);
    if (!snapshot) return undefined;
    return { sessionId: snapshot.sessionId, endCount: -1 };
  }
}
