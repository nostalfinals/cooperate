import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { ContinuationHost } from "../../src/subagent/continuation.ts";
import { StructuredCoordinator } from "../../src/subagent/coordinator.ts";
import type { SubagentInvocation, SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";
import { SubagentService } from "../../src/subagent/service.ts";
import { createSubagentTool } from "../../src/tool/subagent-tool.ts";
import { createCallerCatalog } from "../../src/catalog/catalog.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const worker: AgentDefinition = { name: "worker", description: "work", tools: [], subagentAgents: [], body: "work", filePath: "/worker.md" };
const catalog: DefinitionCatalog = { config: { maxDepth: 3, gcOrphanSessions: true }, definitions: [worker], configPath: "/config", definitionsPath: "/defs" };

function harness() {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runs: SubagentRun[] = [];
  const records: SessionRecord[] = [];
  const invocations: SubagentInvocation[] = [];
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
  const continuation: ContinuationHost = { waitForStartupCommit: async () => undefined, send: vi.fn(async () => undefined) };
  const service = new SubagentService({
    catalog, store, continuation,
    toolFactory: createSubagentTool,
    coordinator: new StructuredCoordinator(3, { generateId: (() => { let id = 0; return () => `${++id}`.padStart(8, "0"); })() }),
    runtimeFactory: { start: vi.fn(async (invocation) => {
      invocations.push(invocation);
      const gate = deferred();
      gates.push(gate);
      const run: SubagentRun = {
        prompt: vi.fn(() => gate.promise), abort: vi.fn(() => gate.resolve()), dispose: vi.fn(async () => undefined),
        messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      };
      runs.push(run);
      return run;
    }) },
    persistOwnership: vi.fn(async () => undefined), visibleSessionIds: () => records.map((record) => record.sessionId),
  });
  return { service, gates, runs, continuation };
}

describe("direct child management actions", () => {
  it("wait captures all active direct children, succeeds across terminal outcomes, and rejects stale or duplicate IDs", async () => {
    const h = harness();
    const one = await h.service.run({ agent: "worker", task: "one", async: true }, { cwd: "/", creatorModel: {} });
    const two = await h.service.run({ agent: "worker", task: "two", async: true }, { cwd: "/", creatorModel: {} });
    const waiting = h.service.wait([one.subagentId!, two.subagentId!]);
    let settled = false;
    void waiting.then(() => { settled = true; });
    h.gates[0]!.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    h.gates[1]!.resolve();
    await waiting;
    await expect(h.service.wait([one.subagentId!])).rejects.toThrow();
    await expect(h.service.wait(["00000001", "00000001"])).rejects.toThrow();
  });

  it("cancels one direct subtree, waits for disposal, and emits only the target's async cancellation notice", async () => {
    const h = harness();
    const started = await h.service.run({ agent: "worker", task: "long", async: true }, { cwd: "/", creatorModel: {} });
    await h.service.cancel(started.subagentId!);
    expect(h.runs[0]!.abort).toHaveBeenCalledOnce();
    expect(h.runs[0]!.dispose).toHaveBeenCalledOnce();
    expect(h.continuation.send).toHaveBeenCalledOnce();
    expect(vi.mocked(h.continuation.send).mock.calls[0]![0]).toMatchObject({ state: "cancelled", agent: "worker" });
    await expect(h.service.cancel(started.subagentId!)).rejects.toThrow();
  });

  it("dispatches wait and cancel through the complete public tool schema", async () => {
    const h = harness();
    const tool = createSubagentTool(h.service, createCallerCatalog(catalog));
    const schema = tool.parameters as { anyOf: Array<{ properties: { action: { const: string } } }> };
    expect(schema.anyOf.map((entry) => entry.properties.action.const)).toEqual(expect.arrayContaining(["wait", "cancel"]));
    const started = await h.service.run({ agent: "worker", task: "long", async: true }, { cwd: "/", creatorModel: {} });
    const cancel = await tool.execute("cancel-call", { action: "cancel", subagentId: started.subagentId } as never, undefined, undefined, { cwd: "/" } as never);
    expect(cancel.content).toEqual([]);
  });
});
