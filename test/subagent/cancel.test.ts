import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { CompletionNotice, Messenger } from "../../src/subagent/messenger.ts";
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
  config: { maxDepth: 3, cleanOrphanSessions: true }, definitions: [worker], configPath: "/config", definitionsPath: "/defs",
};

function harness() {
  const promptGate = deferred();
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
  const messenger: Messenger = {
    waitForStartupCommit: vi.fn(() => new Promise<void>(() => {})),
    send: vi.fn(async (notice) => { notices.push(notice); }),
  };
  const service = new SubagentService({
    catalog, store, runtimeFactory: { start: vi.fn(async () => run) }, messenger,
    toolFactory: () => undefined,
    persistOwnership: vi.fn(async () => undefined), visibleSessionIds: () => records.map((record) => record.sessionId),
  });
  return { service, run, promptGate, notices };
}

describe("single-subagent cancel", () => {
  it("settles without waiting on an uncommitted startup (regression: cancelled UI hung)", async () => {
    const h = harness();
    const started = await h.service.run(
      { agent: "worker", task: "cancel", prompt: "cancel", async: true },
      { cwd: "/project", creatorModel: {}, toolCallId: "call-1" },
    );
    const cancelPromise = h.service.cancel(started.subagentId!);
    h.promptGate.resolve(); // abort takes effect: the run's prompt settles
    await expect(Promise.race([
      cancelPromise.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ])).resolves.toBe("resolved");
  });
});
