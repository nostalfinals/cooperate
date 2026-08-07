import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "../../src/subagent/types.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionTree, historyDirectory, SubagentHistory } from "../../src/session/history.ts";
import { copyMasterSessionDirectory } from "../../src/session/master-copy.ts";
import { cleanOrphanHistoryFiles, collectMasterSessionIds } from "../../src/session/orphan-cleanup.ts";
import { NativeSessionStore } from "../../src/session/native-store.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function snapshot(subagentId: string, startedAt: number, children: readonly SubagentSnapshot[] = []): SubagentSnapshot {
  return Object.freeze({
    subagentId,
    agent: "worker",
    sessionId: `session-${subagentId}`,
    task: `task ${subagentId}`,
    depth: 2,
    startedAt,
    elapsedMs: 100,
    state: "finished",
    children,
  });
}

async function present(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe("SubagentHistory sidecar", () => {
  it("appends, reloads, and lists roots oldest first", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-history-"));
    roots.push(agentDir);
    const history = new SubagentHistory(agentDir, "master-1");
    await history.append({
      subagentId: "a1b2c3d4", sessionId: "s1", endCount: 10, completedAt: 2,
      snapshot: snapshot("a1b2c3d4", 2),
    });
    await history.append({
      subagentId: "e5f6a7b8", sessionId: "s2", endCount: 5, completedAt: 1,
      result: "done", snapshot: snapshot("e5f6a7b8", 1),
    });

    expect(history.roots().map((s) => s.subagentId)).toEqual(["e5f6a7b8", "a1b2c3d4"]);

    const reloaded = new SubagentHistory(agentDir, "master-1");
    await reloaded.load();
    expect(reloaded.roots().map((s) => s.subagentId)).toEqual(["e5f6a7b8", "a1b2c3d4"]);
    expect(reloaded.record("e5f6a7b8")?.result).toBe("done");
    expect(reloaded.record("a1b2c3d4")?.endCount).toBe(10);
  });

  it("is idempotent per subagentId and tolerant of corrupt lines", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-history-"));
    roots.push(agentDir);
    const file = join(historyDirectory(agentDir), "master-1.jsonl");
    await mkdir(join(agentDir, "cooperate", "history"), { recursive: true });
    await writeFile(file, "not json\n", "utf8");

    const history = new SubagentHistory(agentDir, "master-1");
    await history.load();
    expect(history.roots()).toEqual([]);

    await history.append({ subagentId: "a1b2c3d4", sessionId: "s1", endCount: 3, completedAt: 1, snapshot: snapshot("a1b2c3d4", 1) });
    await history.append({ subagentId: "a1b2c3d4", sessionId: "s1", endCount: 3, completedAt: 1, snapshot: snapshot("a1b2c3d4", 1) });
    expect((await readFile(file, "utf8")).split("\n").filter((line) => line.trim()).length).toBe(2);
    expect(history.roots().length).toBe(1);
  });

  it("finds nested snapshots recursively", async () => {
    const history = new SubagentHistory("/tmp", "master-1");
    await history.append({
      subagentId: "parent", sessionId: "sp", endCount: 1, completedAt: 1,
      snapshot: snapshot("parent", 1, [snapshot("child", 2)]),
    });
    expect(history.snapshot("parent")?.subagentId).toBe("parent");
    expect(history.snapshot("child")?.subagentId).toBe("child");
    expect(history.snapshot("missing")).toBeUndefined();
  });

  it("persists nested boundaries alongside records", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-history-"));
    roots.push(agentDir);
    const history = new SubagentHistory(agentDir, "master-1");
    await history.append({
      subagentId: "top", sessionId: "s1", endCount: 4, completedAt: 2,
      snapshot: snapshot("top", 1, [snapshot("child", 2)]),
    });
    await history.appendBoundary({ subagentId: "child", sessionId: "s1", endCount: 2, completedAt: 3 });

    const reloaded = new SubagentHistory(agentDir, "master-1");
    await reloaded.load();
    expect(reloaded.boundary("child")?.endCount).toBe(2);
    expect(reloaded.record("top")?.endCount).toBe(4);
    expect(reloaded.roots().length).toBe(1); // boundaries are not roots
  });
});

describe("buildSessionTree", () => {
  const message = (id: string, parentId: string | null, role: "user" | "assistant"): SessionEntry => ({
    type: "message", id, parentId, timestamp: "2025-01-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text: id }], timestamp: 1 },
  }) as unknown as SessionEntry;

  it("builds a tree from a truncated entry prefix", () => {
    const entries = [
      message("root", null, "user"),
      message("mid", "root", "user"),
      message("leaf", "mid", "user"),
      message("leaf2", "mid", "user"),
    ];
    const tree = buildSessionTree(entries.slice(0, 3));
    expect(tree.map((node) => node.entry.id)).toEqual(["root"]);
    expect(tree[0]!.children.map((node) => node.entry.id)).toEqual(["mid"]);
    expect(tree[0]!.children[0]!.children.map((node) => node.entry.id)).toEqual(["leaf"]);
  });
});

describe("history file fork copying", () => {
  it("copies the sidecar file to the destination master", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-fork-history-"));
    roots.push(agentDir);
    const source = join(agentDir, "cooperate", "sessions", "old-master");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "child.jsonl"), "child bytes\n");
    const historyFile = join(historyDirectory(agentDir), "old-master.jsonl");
    await mkdir(join(agentDir, "cooperate", "history"), { recursive: true });
    await writeFile(historyFile, "record line\n");

    await copyMasterSessionDirectory(agentDir, "old-master", "new-master");

    expect(await readFile(join(historyDirectory(agentDir), "new-master.jsonl"), "utf8")).toBe("record line\n");
    expect(await present(historyFile)).toBe(true);
  });

  it("copies nothing when the source has no history file", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-fork-history-"));
    roots.push(agentDir);
    const source = join(agentDir, "cooperate", "sessions", "old-master");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "child.jsonl"), "child bytes\n");

    await copyMasterSessionDirectory(agentDir, "old-master", "new-master");

    expect(await present(join(historyDirectory(agentDir), "new-master.jsonl"))).toBe(false);
  });
});

describe("orphan history file cleanup", () => {
  it("removes history files whose master session no longer exists", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-history-"));
    roots.push(agentDir);
    const masters = join(agentDir, "sessions", "--project--");
    await mkdir(masters, { recursive: true });
    await writeFile(join(masters, "live.jsonl"), '{"type":"session","version":3,"id":"live-master","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/project"}\n');
    const dir = join(agentDir, "cooperate", "history");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "live-master.jsonl"), "keep\n");
    await writeFile(join(dir, "dead-master.jsonl"), "remove\n");
    await writeFile(join(dir, "not-jsonl.txt"), "ignore\n");

    const ids = await collectMasterSessionIds(agentDir);
    const removed = await cleanOrphanHistoryFiles(agentDir, ids, { trash: async () => false });

    expect(removed).toEqual([join(dir, "dead-master.jsonl")]);
    expect(await present(join(dir, "live-master.jsonl"))).toBe(true);
    expect(await present(join(dir, "not-jsonl.txt"))).toBe(true);
  });

  it("reuses trash when available", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-history-"));
    roots.push(agentDir);
    const dir = join(agentDir, "cooperate", "history");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dead-master.jsonl"), "remove\n");
    const trash = vi.fn(async (path: string) => { await rm(path, { force: true }); return true; });

    const removed = await cleanOrphanHistoryFiles(agentDir, new Set(["live-master"]), { trash });

    expect(removed).toEqual([join(dir, "dead-master.jsonl")]);
    expect(trash).toHaveBeenCalledWith(join(dir, "dead-master.jsonl"));
  });
});

describe("historical tree truncation through the native store", () => {
  it("loads only the entries up to endCount of the run", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-history-native-"));
    roots.push(agentDir);
    const store = new NativeSessionStore({ agentDir, masterSessionId: "master-1", cwd: "/project" });
    const record = await store.create();
    const native = record.native as { appendMessage(message: unknown): string; getEntries(): readonly unknown[] };
    native.appendMessage({ role: "user", content: "task" });
    native.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }] });

    const history = new SubagentHistory(agentDir, "master-1");
    await history.append({
      subagentId: "a1b2c3d4", sessionId: record.sessionId, endCount: 2, completedAt: 1,
      snapshot: snapshot("a1b2c3d4", 1),
    });

    const opened = await store.open(record.sessionId);
    const entries = (opened.native as { getEntries(): readonly SessionEntry[] }).getEntries();
    const tree = buildSessionTree(entries.slice(0, 2));
    expect(tree.length).toBe(1);
    expect(tree[0]!.children.length).toBe(1);
  });
});
