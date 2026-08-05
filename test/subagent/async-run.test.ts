import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { CompletionNotice, ContinuationHost } from "../../src/subagent/continuation.ts";
import type { SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";
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
  const promptGate = deferred();
  const commitGate = deferred();
  const notices: CompletionNotice[] = [];
  const records: SessionRecord[] = [];
  const store: SessionStore = {
    create: vi.fn(async () => {
      const record = { sessionId: `session-${records.length + 1}`, file: `/session-${records.length + 1}.jsonl` };
      records.push(record);
      return record;
    }),
    open: vi.fn(async (id) => records.find((record) => record.sessionId === id)!),
    list: vi.fn(async () => records),
    inspect: vi.fn(async () => ({ task: "task", result: "result" })),
  };
  const run: SubagentRun = {
    prompt: vi.fn(() => promptGate.promise),
    abort: vi.fn(() => promptGate.resolve()),
    dispose: vi.fn(async () => undefined),
    messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  };
  const continuation: ContinuationHost = {
    waitForStartupCommit: vi.fn(() => commitGate.promise),
    send: vi.fn(async (notice) => { notices.push(notice); }),
  };
  const service = new SubagentService({
    catalog, store, runtimeFactory: { start: vi.fn(async () => run) }, continuation,
    toolFactory: () => undefined,
    persistOwnership: vi.fn(async () => undefined), visibleSessionIds: () => records.map((record) => record.sessionId),
  });
  return { service, run, promptGate, commitGate, notices };
}

describe("asynchronous subagent run", () => {
  it("returns startup identity promptly and gates its exactly-once completion until the tool result is committed", async () => {
    const h = harness();
    const started = await h.service.run(
      { agent: "worker", task: "work", async: true },
      { cwd: "/project", creatorModel: {}, toolCallId: "call-1" },
    );

    expect(started).toMatchObject({ sessionId: "session-1", subagentId: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(h.run.prompt).toHaveBeenCalledWith("work");
    h.promptGate.resolve();
    await Promise.resolve();
    expect(h.notices).toEqual([]);

    h.commitGate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toMatchObject({ agent: "worker", state: "finished", sessionId: "session-1", result: "done" });
    expect(h.notices[0]).not.toHaveProperty("subagentId");
  });

  it("reports asynchronous failures but suppresses lifecycle-wide cancellation without waiting on an uncommitted startup", async () => {
    const failed = harness();
    vi.mocked(failed.run.prompt).mockRejectedValueOnce(new Error("provider failed"));
    await failed.service.run(
      { agent: "worker", task: "fail", async: true },
      { cwd: "/project", creatorModel: {}, toolCallId: "failed-call" },
    );
    failed.commitGate.resolve();
    await vi.waitFor(() => expect(failed.notices).toHaveLength(1));
    expect(failed.notices[0]).toMatchObject({ state: "failed", reason: "provider failed" });

    const cancelled = harness();
    await cancelled.service.run(
      { agent: "worker", task: "cancel", async: true },
      { cwd: "/project", creatorModel: {}, toolCallId: "cancelled-call" },
    );
    await expect(cancelled.service.shutdown()).resolves.toBeUndefined();
    expect(cancelled.notices).toEqual([]);
  });
});
