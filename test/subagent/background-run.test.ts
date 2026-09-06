import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { CompletionNotice, Messenger } from "../../src/subagent/messenger.ts";
import { SubagentService } from "../../src/subagent/service.ts";
import { extractFinalText } from "../../src/subagent/result.ts";
import type { SubagentInvocation, SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";

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
  definitions: [definition("worker"), definition("reviewer")],
  configPath: "/config.json",
  definitionsPath: "/defs",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options: { fail?: Error; output?: unknown[] } = {}) {
  const records = new Map<string, SessionRecord>();
  const created: string[] = [];
  const ownership: string[] = [];
  const notices: CompletionNotice[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  const store: SessionStore = {
    create: vi.fn(async () => {
      const record = { sessionId: `session-${records.size + 1}`, file: `/sessions/session-${records.size + 1}.jsonl` };
      records.set(record.sessionId, record);
      created.push(record.sessionId);
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
  const messenger: Messenger = {
    waitForStartupCommit: async () => undefined,
    send: vi.fn(async (notice) => { notices.push(notice); }),
    sendReminder: vi.fn(async () => undefined),
  };
  const invocations: SubagentInvocation[] = [];
  const runs: SubagentRun[] = [];
  const service = new SubagentService({
    catalog,
    store,
    messenger,
    runtimeFactory: { start: vi.fn(async (invocation) => {
      invocations.push(invocation);
      const gate = deferred();
      gates.push(gate);
      const run: SubagentRun = {
        prompt: vi.fn(async () => {
          if (options.fail) throw options.fail;
          await gate.promise;
        }),
        abort: vi.fn(() => gate.resolve()),
        dispose: vi.fn(async () => undefined),
        messagesSinceStart: () => options.output ?? [
          { role: "assistant", content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "x" }, { type: "text", text: " final " }] },
        ],
      };
      runs.push(run);
      return run;
    }) },
    toolFactory: () => undefined,
    persistOwnership: vi.fn(async (sessionId) => { ownership.push(sessionId); }),
    visibleSessionIds: () => ownership,
  });
  return { service, store, runs, gates, notices, invocations, ownership, created, records };
}

describe("background subagent run", () => {
  it("creates ownership before runtime exposure, prompts with only the task, and reports startup identity", async () => {
    const h = harness();
    const order: string[] = [];
    vi.mocked(h.store.create).mockImplementation(async () => {
      order.push("create");
      const record = { sessionId: "session-1", file: "/sessions/session-1.jsonl" };
      h.records.set(record.sessionId, record);
      return record;
    });
    const service = new SubagentService({
      catalog,
      store: h.store,
      messenger: { waitForStartupCommit: async () => undefined, send: vi.fn(async () => undefined), sendReminder: vi.fn(async () => undefined) },
      runtimeFactory: { start: vi.fn(async (invocation) => {
        order.push("start");
        h.invocations.push(invocation);
        const run: SubagentRun = {
          prompt: vi.fn(async () => undefined),
          abort: vi.fn(),
          dispose: vi.fn(async () => undefined),
          messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
        };
        h.runs.push(run);
        return run;
      }) },
      toolFactory: () => undefined,
      persistOwnership: vi.fn(async (id) => { order.push("own"); h.ownership.push(id); }),
      visibleSessionIds: () => h.ownership,
    });

    const result = await service.run({ agent: "worker", task: "Do exactly this", prompt: "Do exactly this" }, { cwd: "/project", creatorModel: { id: "creator" } });

    expect(order).toEqual(["create", "own", "start"]);
    expect(h.invocations[0]).toMatchObject({ definition: { name: "worker" }, record: { sessionId: "session-1" }, task: "Do exactly this" });
    await vi.waitFor(() => expect(h.runs[0]!.prompt).toHaveBeenCalledWith("Do exactly this"));
    expect(result).toMatchObject({ sessionId: "session-1", subagentId: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it("resumes a visible session under any currently permitted definition without adding ownership", async () => {
    const h = harness();
    h.records.set("session-old", { sessionId: "session-old", file: "/sessions/old.jsonl" });
    h.ownership.push("session-old");

    await h.service.run({ agent: "reviewer", task: "Review", prompt: "Review", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} });

    expect(h.store.create).not.toHaveBeenCalled();
    expect(h.invocations[0].definition.name).toBe("reviewer");
    expect(h.ownership).toEqual(["session-old"]);
  });

  it("rejects hidden and locked sessions and releases a lock after a background failure", async () => {
    const h = harness({ fail: new Error("provider unavailable") });
    h.records.set("session-old", { sessionId: "session-old", file: "/sessions/old.jsonl" });
    h.ownership.push("session-old");

    await h.service.run({ agent: "worker", task: "Fail", prompt: "Fail", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} });
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    await expect(h.service.run({ agent: "worker", task: "Again", prompt: "Again", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} })).rejects.toThrow();
    await vi.waitFor(() => expect(h.notices[0]).toMatchObject({ state: "failed", reason: "provider unavailable" }));
    expect(h.runs[0]!.dispose).toHaveBeenCalledOnce();

    await expect(h.service.run({ agent: "worker", task: "Retry", prompt: "Retry", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} })).resolves.toBeDefined();
    await expect(h.service.run({ agent: "worker", task: "No", prompt: "No", sessionId: "hidden" }, { cwd: "/project", creatorModel: {} })).rejects.toThrow();
  });

  it("aborts the child from the tool signal, disposes it, and keeps the cancellation silent", async () => {
    const h = harness();
    const controller = new AbortController();

    const started = await h.service.run({ agent: "worker", task: "Long", prompt: "Long" }, { cwd: "/project", creatorModel: {}, signal: controller.signal });
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    controller.abort();

    await vi.waitFor(() => expect(h.runs[0]!.dispose).toHaveBeenCalledOnce());
    expect(h.runs[0]!.abort).toHaveBeenCalledOnce();
    // The invoker aborted its own tool call; a cancelled background child stays silent.
    expect(h.notices).toEqual([]);
    expect(h.service.snapshotOrLast(started.subagentId!)).toMatchObject({ state: "cancelled" });
  });

  it("finishes successfully when pi's auto-retry recovers after a transient agent_end failure", async () => {
    const h = harness();

    await h.service.run({ agent: "worker", task: "Recover", prompt: "Recover" }, { cwd: "/project", creatorModel: {} });
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    // pi emits agent_end with a transient provider failure, then auto-retries within the same prompt().
    await h.invocations[0]!.onAgentEnd!({ state: "failed", reason: "fetch failed" });
    h.gates[0]!.resolve();

    await vi.waitFor(() => expect(h.notices[0]).toMatchObject({ state: "finished", result: expect.stringContaining("final") }));
    expect(h.runs[0]!.dispose).toHaveBeenCalledOnce();
  });
});

describe("extractFinalText", () => {
  it("uses only the terminal assistant message and its last nonempty text block", () => {
    expect(extractFinalText([
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "toolResult", content: [{ type: "text", text: "ignored" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }, { type: "text", text: "chosen" }, { type: "text", text: "" }] },
    ])).toBe("chosen");
    expect(extractFinalText([{ role: "assistant", content: [{ type: "thinking", thinking: "only" }] }])).toBe("<none>");
  });
});
