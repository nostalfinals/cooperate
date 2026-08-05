import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";
import { NativeSessionStore } from "../../src/session/native-store.ts";
import { isAbortedAgentEnd } from "../../src/subagent/result.ts";
import { SubagentService } from "../../src/subagent/service.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const worker: AgentDefinition = {
  name: "worker", description: "work", tools: [], subagentAgents: [], body: "work", filePath: "/worker.md",
};
const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, gcOrphanSessions: true }, definitions: [worker], configPath: "/config", definitionsPath: "/defs",
};

function harness() {
  let next = 0;
  const records: SessionRecord[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  const runs: SubagentRun[] = [];
  const store: SessionStore = {
    create: vi.fn(async () => {
      const record = { sessionId: `session-${++next}`, file: `/session-${next}.jsonl` };
      records.push(record);
      return record;
    }),
    open: vi.fn(async (id) => records.find((record) => record.sessionId === id)!),
    list: vi.fn(async () => records),
    inspect: vi.fn(async () => ({ task: "task", result: "result" })),
  };
  const service = new SubagentService({
    catalog,
    store,
    toolFactory: () => undefined,
    messenger: { waitForStartupCommit: async () => undefined, send: vi.fn(async () => undefined) },
    runtimeFactory: {
      start: vi.fn(async () => {
        const gate = deferred();
        gates.push(gate);
        const run: SubagentRun = {
          prompt: vi.fn(() => gate.promise),
          abort: vi.fn(() => gate.resolve()),
          dispose: vi.fn(async () => undefined),
          messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        };
        runs.push(run);
        return run;
      }),
    },
    persistOwnership: vi.fn(async () => undefined),
    visibleSessionIds: () => records.map((record) => record.sessionId),
  });
  return { service, runs, gates };
}

describe("Pi session lifecycle cancellation", () => {
  it("awaits cancellation for tree navigation but keeps the session service reusable", async () => {
    const h = harness();
    await h.service.run({ agent: "worker", task: "first", prompt: "first", async: true }, { cwd: "/project", creatorModel: {} });

    await h.service.cancelActive("tree navigation");
    expect(h.runs[0]!.abort).toHaveBeenCalledOnce();
    expect(h.service.listSubagents()).toEqual([]);

    const second = h.service.run({ agent: "worker", task: "second", prompt: "second" }, { cwd: "/project", creatorModel: {} });
    await vi.waitFor(() => expect(h.runs).toHaveLength(2));
    h.gates[1]!.resolve();
    await expect(second).resolves.toMatchObject({ sessionId: "session-2", result: "done" });
  });

  it("opens a crash-left native session as unlocked and resumable in a fresh runtime", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-crash-"));
    try {
      const originalStore = new NativeSessionStore({ agentDir, masterSessionId: "master", cwd: "/project" });
      const crashLeft = await originalStore.create();
      const freshStore = new NativeSessionStore({ agentDir, masterSessionId: "master", cwd: "/project" });
      const run: SubagentRun = {
        prompt: vi.fn(async () => undefined), abort: vi.fn(), dispose: vi.fn(async () => undefined),
        messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "resumed" }] }],
      };
      const freshService = new SubagentService({
        catalog, store: freshStore, runtimeFactory: { start: vi.fn(async () => run) },
        toolFactory: () => undefined,
        persistOwnership: vi.fn(async () => undefined), visibleSessionIds: () => [crashLeft.sessionId],
      });

      expect(await freshService.listSessions()).toEqual([
        expect.objectContaining({ session: crashLeft.sessionId, locked: false }),
      ]);
      await expect(freshService.run(
        { agent: "worker", task: "resume", prompt: "resume", sessionId: crashLeft.sessionId },
        { cwd: "/project", creatorModel: {} },
      )).resolves.toMatchObject({ sessionId: crashLeft.sessionId, result: "resumed" });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("permanently rejects starts after shutdown and recognizes only an aborted terminal assistant turn", async () => {
    const h = harness();
    await h.service.run({ agent: "worker", task: "active", prompt: "active", async: true }, { cwd: "/project", creatorModel: {} });
    await h.service.shutdown();
    await expect(h.service.run({ agent: "worker", task: "late", prompt: "late" }, { cwd: "/project", creatorModel: {} })).rejects.toThrow();

    expect(isAbortedAgentEnd([{ role: "assistant", stopReason: "aborted" }])).toBe(true);
    expect(isAbortedAgentEnd([{ role: "assistant", stopReason: "stop" }])).toBe(false);
    expect(isAbortedAgentEnd([{ role: "user" }])).toBe(false);
  });
});
