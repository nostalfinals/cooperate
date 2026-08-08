import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import { SubagentService } from "../../src/subagent/service.ts";
import { SubagentHistory } from "../../src/session/history.ts";
import { StructuredCoordinator } from "../../src/subagent/coordinator.ts";
import type { SubagentInvocation, SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const definition = (name = "worker"): AgentDefinition => ({
  name,
  description: `${name} description`,
  tools: ["read"],
  subagentAgents: [],
  body: `${name} instructions`,
  filePath: `/defs/${name}.md`,
});

const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, cleanOrphanSessions: true },
  definitions: [definition("worker")],
  configPath: "/config.json",
  definitionsPath: "/defs",
};

async function harness(options: { fail?: Error; output?: unknown[] } = {}) {
  const records = new Map<string, SessionRecord>();
  const agentDir = await mkdtemp(join(tmpdir(), "cooperate-history-record-"));
  temporaryDirectories.push(agentDir);
  const history = new SubagentHistory(agentDir, "master-1");
  const store: SessionStore = {
    create: vi.fn(async () => {
      const record = {
        sessionId: `session-${records.size + 1}`,
        file: `/sessions/session-${records.size + 1}.jsonl`,
        native: { getEntries: () => [{ id: "1" }, { id: "2" }, { id: "3" }] },
      };
      records.set(record.sessionId, record);
      return record;
    }),
    open: vi.fn(async (sessionId) => {
      const record = records.get(sessionId);
      if (!record) throw new Error(`Session '${sessionId}' does not exist`);
      return record;
    }),
    list: vi.fn(async () => [...records.values()]),
    inspect: vi.fn(async () => ({ task: "previous task", result: "previous result" })),
  };
  const run: SubagentRun = {
    prompt: vi.fn(async () => {
      if (options.fail) throw options.fail;
    }),
    abort: vi.fn(),
    dispose: vi.fn(async () => undefined),
    messagesSinceStart: () => options.output ?? [
      { role: "assistant", content: [{ type: "text", text: "final result" }] },
    ],
  };
  const invocations: SubagentInvocation[] = [];
  const service = new SubagentService({
    catalog,
    store,
    history,
    runtimeFactory: { start: vi.fn(async (invocation) => { invocations.push(invocation); return run; }) },
    toolFactory: () => undefined,
    persistOwnership: vi.fn(async () => undefined),
    visibleSessionIds: () => [],
  });
  return { service, store, run, invocations, records, history };
}

describe("history recording on run completion", () => {
  it("records a finished top-level run with snapshot, result, and endCount", async () => {
    const h = await harness();
    const response = await h.service.run(
      { agent: "worker", task: "do the thing", prompt: "do it now" },
      { cwd: "/project", creatorModel: {} },
    );

    const record = h.history.record(response.subagentId!);
    expect(record).toBeDefined();
    expect(record!.snapshot.state).toBe("finished");
    expect(record!.snapshot.agent).toBe("worker");
    expect(record!.snapshot.task).toBe("do the thing");
    expect(record!.result).toContain("final result");
    expect(record!.endCount).toBe(3);
    expect(record!.sessionId).toBe(response.sessionId);
    expect(h.history.roots().map((s) => s.subagentId)).toEqual([response.subagentId]);
  });

  it("records failed runs too", async () => {
    const h = await harness({ fail: new Error("boom") });
    await expect(h.service.run(
      { agent: "worker", task: "t", prompt: "p" },
      { cwd: "/project", creatorModel: {} },
    )).rejects.toThrow();

    expect(h.history.roots().some((s) => s.state === "failed")).toBe(true);
  });

  it("writes only a completion boundary for nested services", async () => {
    const h = await harness();
    const coordinator = new StructuredCoordinator(3);
    const parent = coordinator.start({ sessionId: "session-parent", agent: "worker", task: "parent" });
    const nested = new SubagentService({
      catalog,
      store: h.store,
      history: h.history,
      coordinator,
      parentId: parent.subagentId,
      runtimeFactory: { start: vi.fn(async () => h.run) },
      toolFactory: () => undefined,
      persistOwnership: vi.fn(async () => undefined),
      visibleSessionIds: () => [],
    }, h.records);
    const response = await nested.run(
      { agent: "worker", task: "child task", prompt: "child prompt" },
      { cwd: "/project", creatorModel: {} },
    );

    expect(h.history.roots()).toEqual([]);
    const boundary = h.history.boundary(response.subagentId!);
    expect(boundary).toBeDefined();
    expect(boundary!.endCount).toBe(3);
    expect(boundary!.sessionId).toBe(response.sessionId);
  });

  it("resolves nested subagents through the recursive snapshot", async () => {
    const h = await harness();
    const nested = await h.store.create();
    const childId = "c0ffee00";
    const child = Object.freeze({
      subagentId: childId,
      agent: "worker",
      sessionId: nested.sessionId,
      task: "child",
      depth: 3,
      startedAt: 2,
      elapsedMs: 10,
      state: "finished",
      children: Object.freeze([]),
    });
    await h.history.append({
      subagentId: "a1b2c3d4",
      sessionId: "session-1",
      endCount: 2,
      completedAt: Date.now(),
      snapshot: Object.freeze({
        subagentId: "a1b2c3d4",
        agent: "worker",
        sessionId: "session-1",
        task: "top",
        depth: 2,
        startedAt: 1,
        elapsedMs: 10,
        state: "finished",
        children: Object.freeze([child]),
      }),
    });
    await h.history.appendBoundary({ subagentId: childId, sessionId: nested.sessionId, endCount: 2, completedAt: 3 });

    const detail = h.service.historyRecord(childId);
    expect(detail).toBeDefined();
    expect(detail!.snapshot.subagentId).toBe(childId);
    expect(detail!.result).toBeUndefined();

    // Nested runs truncate their shared session to their own boundary.
    const tree = await h.service.loadHistoryTree(childId);
    expect(tree).toBeDefined();
    expect(tree!.length).toBe(2);
  });

  it("truncates a shared session per nested subagent boundary", async () => {
    const h = await harness();
    const shared = await h.store.create();
    const childA = "aaaa0001";
    const childB = "bbbb0002";
    await h.history.appendBoundary({ subagentId: childA, sessionId: shared.sessionId, endCount: 2, completedAt: 1 });
    await h.history.appendBoundary({ subagentId: childB, sessionId: shared.sessionId, endCount: 3, completedAt: 2 });

    const treeA = await h.service.loadHistoryTree(childA);
    const treeB = await h.service.loadHistoryTree(childB);
    expect(treeA!.length).toBe(2);
    expect(treeB!.length).toBe(3);
  });
});
