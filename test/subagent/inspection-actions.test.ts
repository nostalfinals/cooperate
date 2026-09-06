import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { CompletionNotice, Messenger, ReminderNotice } from "../../src/subagent/messenger.ts";
import type { SubagentInvocation, SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";
import { SubagentService } from "../../src/subagent/service.ts";
import { createSubagentTool } from "../../src/tool/subagent-tool.ts";
import { createCallerCatalog } from "../../src/catalog/catalog.ts";
import { SubagentHistory } from "../../src/session/history.ts";
import { messageContent, summarizeEntries } from "../../src/subagent/messages.ts";

const temporaryDirectories: string[] = [];
afterAll(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

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

interface Harness {
  service: SubagentService;
  tool: ReturnType<typeof createSubagentTool>;
  gates: Array<ReturnType<typeof deferred>>;
  runs: SubagentRun[];
  invocations: SubagentInvocation[];
  reminders: ReminderNotice[];
  notices: CompletionNotice[];
  setBranch(sessionId: string, entries: unknown[]): void;
}

async function harness(config: { timerReminderSeconds?: number } = {}): Promise<Harness> {
  const agentDir = await mkdtemp(join(tmpdir(), "cooperate-inspect-"));
  temporaryDirectories.push(agentDir);
  const history = new SubagentHistory(agentDir, "master-1");
  const records: SessionRecord[] = [];
  const branches = new Map<string, unknown[]>();
  const gates: Array<ReturnType<typeof deferred>> = [];
  const runs: SubagentRun[] = [];
  const invocations: SubagentInvocation[] = [];
  const reminders: ReminderNotice[] = [];
  const notices: CompletionNotice[] = [];
  const store: SessionStore = {
    create: vi.fn(async () => {
      const sessionId = `session-${records.length + 1}`;
      const record: SessionRecord = {
        sessionId,
        file: `/${sessionId}.jsonl`,
        native: { getBranch: () => branches.get(sessionId) ?? [], getEntries: () => branches.get(sessionId) ?? [] },
      };
      records.push(record);
      return record;
    }),
    open: vi.fn(async (id) => records.find((record) => record.sessionId === id)!),
    list: vi.fn(async () => records),
    inspect: vi.fn(async () => ({ task: "task", result: "result" })),
  };
  const messenger: Messenger = {
    waitForStartupCommit: async () => undefined,
    send: vi.fn(async (notice) => { notices.push(notice); }),
    sendReminder: vi.fn(async (reminder) => { reminders.push(reminder); }),
  };
  const service = new SubagentService({
    catalog: { ...catalog, config: { ...catalog.config, ...config } },
    store, messenger, history,
    toolFactory: createSubagentTool,
    runtimeFactory: { start: vi.fn(async (invocation) => {
      invocations.push(invocation);
      const gate = deferred();
      gates.push(gate);
      const run: SubagentRun = {
        prompt: vi.fn(() => gate.promise),
        abort: vi.fn(() => gate.resolve()),
        dispose: vi.fn(async () => undefined),
        steer: vi.fn(async () => undefined),
        getSteeringMessages: vi.fn(() => ["focus on tests"]),
        messagesSinceStart: () => [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
          { role: "assistant", content: [{ type: "text", text: "halfway done" }] },
        ],
      };
      runs.push(run);
      return run;
    }) },
    persistOwnership: vi.fn(async () => undefined),
    visibleSessionIds: () => records.map((record) => record.sessionId),
  });
  return {
    service,
    tool: createSubagentTool(service, createCallerCatalog(catalog)),
    gates, runs, invocations, reminders, notices,
    setBranch: (sessionId, entries) => branches.set(sessionId, entries),
  };
}

describe("list-subagents with completed history", () => {
  it("reports only active direct children by default and completed ones with all", async () => {
    const h = await harness();
    const first = await h.service.run({ agent: "worker", task: "one", prompt: "one" }, { cwd: "/", creatorModel: {} });
    await h.service.run({ agent: "worker", task: "two", prompt: "two" }, { cwd: "/", creatorModel: {} });

    expect(h.service.listSubagents()).toHaveLength(2);
    expect(h.service.listSubagents(true)).toHaveLength(2);

    h.gates[0]!.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.service.listSubagents().map((entry) => entry.subagentId)).not.toContain(first.subagentId);
    const all = h.service.listSubagents(true);
    expect(all.map((entry) => entry.subagentId)).toContain(first.subagentId);
    expect(all.find((entry) => entry.subagentId === first.subagentId)).toMatchObject({ state: "finished", agent: "worker" });
  });
});

describe("subagent inspect", () => {
  it("returns identity, live steering, and the latest classified message of a direct child", async () => {
    const h = await harness();
    const started = await h.service.run({ agent: "worker", task: "work hard", prompt: "work" }, { cwd: "/", creatorModel: {} });

    const inspection = h.service.inspectSubagent(started.subagentId!);
    expect(inspection).toMatchObject({
      subagentId: started.subagentId,
      sessionId: "session-1",
      agent: "worker",
      task: "work hard",
      state: "running",
      steering: ["focus on tests"],
      lastMessage: { role: "assistant", kind: "text", preview: "halfway done" },
    });

    expect(() => h.service.inspectSubagent("ffffffff")).toThrow();
  });
});

describe("subagent history", () => {
  it("pages a live transcript as id-tagged summaries and expands a single message by id", async () => {
    const h = await harness();
    const started = await h.service.run({ agent: "worker", task: "work", prompt: "work" }, { cwd: "/", creatorModel: {} });
    h.setBranch("session-1", [
      { type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "please work" }] } },
      { type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] } },
      { type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);

    const page = await h.service.historyMessages(started.subagentId!);
    expect(page).toMatchObject({ total: 3, offset: 0, limit: 50 });
    expect(page.messages).toEqual([
      { id: "e1", role: "user", kind: "text", preview: "please work" },
      { id: "e2", role: "assistant", kind: "tool-call", preview: expect.stringContaining("read") },
      { id: "e3", role: "assistant", kind: "text", preview: "done" },
    ]);

    const paged = await h.service.historyMessages(started.subagentId!, { offset: 1, limit: 1 });
    expect(paged.messages).toEqual([{ id: "e2", role: "assistant", kind: "tool-call", preview: "read" }]);

    const expanded = await h.service.historyMessages(started.subagentId!, { messageId: "e2" });
    expect(expanded.message).toContain("read");
    expect(expanded.message).toContain("a.ts");

    await expect(h.service.historyMessages(started.subagentId!, { messageId: "nope" })).rejects.toThrow();
  });

  it("serves a completed child's transcript from the truncated history view", async () => {
    const h = await harness();
    const started = await h.service.run({ agent: "worker", task: "work", prompt: "work" }, { cwd: "/", creatorModel: {} });
    h.setBranch("session-1", [
      { type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "please work" }] } },
      { type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "custom", id: "e3", parentId: "e2", timestamp: "t", customType: "cooperate-ownership", data: {} },
    ]);
    h.gates[0]!.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));

    const page = await h.service.historyMessages(started.subagentId!);
    expect(page.messages).toEqual([
      { id: "e1", role: "user", kind: "text", preview: "please work" },
      { id: "e2", role: "assistant", kind: "text", preview: "done" },
    ]);
  });
});

describe("subagent steer", () => {
  it("delivers text to the running child and rejects inactive ids", async () => {
    const h = await harness();
    const started = await h.service.run({ agent: "worker", task: "work", prompt: "work" }, { cwd: "/", creatorModel: {} });

    await h.service.steer(started.subagentId!, "change course");
    expect(h.runs[0]!.steer).toHaveBeenCalledWith("change course");

    await expect(h.service.steer("ffffffff", "nope")).rejects.toThrow();

    const tool = await h.tool.execute("call", { action: "steer", subagentId: started.subagentId, text: "via tool" } as never, undefined, undefined, { cwd: "/" } as never);
    expect(tool.content[0]).toMatchObject({ type: "text" });
    expect(h.runs[0]!.steer).toHaveBeenCalledWith("via tool");
    await expect(h.tool.execute("call", { action: "steer", subagentId: started.subagentId } as never, undefined, undefined, { cwd: "/" } as never)).rejects.toThrow();
  });
});

describe("run reminders", () => {
  it("honors a custom timerReminderSeconds interval", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness({ timerReminderSeconds: 60 });
      const started = await h.service.run({ agent: "worker", task: "work", prompt: "work" }, { cwd: "/", creatorModel: {} });

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(h.reminders).toHaveLength(1);
      expect(h.reminders[0]).toMatchObject({ subagentIds: [started.subagentId] });

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(h.reminders).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a timer reminder every ten minutes and resets the clock once everything finishes", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness();
      const started = await h.service.run({ agent: "worker", task: "work", prompt: "work" }, { cwd: "/", creatorModel: {} });

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(h.reminders).toEqual([]);

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(h.reminders).toHaveLength(1);
      expect(h.reminders[0]).toMatchObject({ subagentIds: [started.subagentId] });

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(h.reminders).toHaveLength(2);

      h.gates[0]!.resolve();
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));

      // All subagents are done: the clock resets and stays silent.
      const count = h.reminders.length;
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(h.reminders).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("session entry summaries", () => {
  it("summarizes message entries with stable ids and recovers full content", () => {
    const entries = [
      { type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", name: "read", arguments: { path: "x" } }] } },
      { type: "custom_message", id: "b", parentId: "a", timestamp: "t", customType: "subagent", content: "note", display: true },
    ] as never[];
    expect(summarizeEntries(entries)).toEqual([
      { id: "a", role: "assistant", kind: "tool-call", preview: expect.stringContaining("working") },
      { id: "b", role: "custom", kind: "custom", preview: "note" },
    ]);
    expect(messageContent(entries[0]!)).toContain("read");
    expect(messageContent(entries[0]!)).toContain("x");
  });
});
