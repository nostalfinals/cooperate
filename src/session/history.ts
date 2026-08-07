import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../subagent/types.ts";

/** One completed top-level subagent run, persisted per master session. */
export interface HistoryRecord {
  subagentId: string;
  sessionId: string;
  snapshot: SubagentSnapshot;
  result?: string;
  /** Session entry count at completion; history detail views truncate the file to this prefix. */
  endCount: number;
  completedAt: number;
}

/** Completion boundary of a nested run; lets a shared session file be truncated per subagent. */
export interface HistoryBoundary {
  subagentId: string;
  sessionId: string;
  endCount: number;
  completedAt: number;
}

export function historyDirectory(agentDir: string): string {
  return resolve(agentDir, "cooperate", "history");
}

/** Build a defensive session tree from a prefix of a session's entries. */
export function buildSessionTree(entries: readonly SessionEntry[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const entry of entries) byId.set(entry.id, { entry, children: [] });
  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.entry.parentId;
    if (parentId !== null && parentId !== undefined) {
      const parent = byId.get(parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

function findSnapshot(snapshot: SubagentSnapshot, subagentId: string): SubagentSnapshot | undefined {
  if (snapshot.subagentId === subagentId) return snapshot;
  for (const child of snapshot.children) {
    const found = findSnapshot(child, subagentId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Append-only sidecar history of completed top-level subagent runs for one
 * master session. Survives restarts and pi session compaction because it lives
 * outside the master conversation file. The subagent session files themselves
 * stay in the master namespace and are opened lazily on demand.
 */
export class SubagentHistory {
  readonly file: string;
  private readonly records = new Map<string, HistoryRecord>();
  private readonly boundaries = new Map<string, HistoryBoundary>();
  private loaded = false;

  constructor(agentDir: string, masterSessionId: string) {
    this.file = resolve(historyDirectory(agentDir), `${masterSessionId}.jsonl`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch {
      return; // No history yet.
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<HistoryRecord> & Partial<HistoryBoundary>;
        if (parsed && typeof parsed.subagentId === "string" && typeof parsed.sessionId === "string"
          && typeof parsed.endCount === "number") {
          if (parsed.snapshot && typeof parsed.snapshot.subagentId === "string") {
            this.records.set(parsed.subagentId, parsed as HistoryRecord);
          } else {
            this.boundaries.set(parsed.subagentId, parsed as HistoryBoundary);
          }
        }
      } catch {
        // Corrupt lines are skipped; history is best-effort metadata.
      }
    }
  }

  async append(record: HistoryRecord): Promise<void> {
    if (this.records.has(record.subagentId)) return;
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    this.records.set(record.subagentId, record);
  }

  async appendBoundary(boundary: HistoryBoundary): Promise<void> {
    if (this.boundaries.has(boundary.subagentId)) return;
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(boundary)}\n`, { encoding: "utf8" });
    this.boundaries.set(boundary.subagentId, boundary);
  }

  record(subagentId: string): HistoryRecord | undefined {
    return this.records.get(subagentId);
  }

  boundary(subagentId: string): HistoryBoundary | undefined {
    return this.boundaries.get(subagentId);
  }

  roots(): readonly SubagentSnapshot[] {
    return [...this.records.values()]
      .map((record) => record.snapshot)
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  snapshot(subagentId: string): SubagentSnapshot | undefined {
    const direct = this.records.get(subagentId);
    if (direct) return direct.snapshot;
    for (const record of this.records.values()) {
      const found = findSnapshot(record.snapshot, subagentId);
      if (found) return found;
    }
    return undefined;
  }
}
