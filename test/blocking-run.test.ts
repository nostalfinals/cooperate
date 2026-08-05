import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../src/catalog/types.ts";
import { SubagentService } from "../src/subagent/service.ts";
import { extractFinalText } from "../src/subagent/result.ts";
import type { ChildInvocation, ChildRun, SessionRecord, SessionStore } from "../src/subagent/ports.ts";

const definition = (name = "worker"): AgentDefinition => ({
  name,
  description: `${name} description`,
  tools: ["read"],
  subagentAgents: [],
  body: `${name} instructions`,
  filePath: `/defs/${name}.md`,
});

const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, gcOrphanSessions: true },
  definitions: [definition("worker"), definition("reviewer")],
  configPath: "/config.json",
  definitionsPath: "/defs",
};

function harness(options: { fail?: Error; output?: unknown[] } = {}) {
  const records = new Map<string, SessionRecord>();
  const created: string[] = [];
  const ownership: string[] = [];
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
  const invocations: ChildInvocation[] = [];
  const run: ChildRun = {
    prompt: vi.fn(async () => {
      if (options.fail) throw options.fail;
    }),
    abort: vi.fn(),
    dispose: vi.fn(async () => undefined),
    messagesSinceStart: () => options.output ?? [
      { role: "assistant", content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "x" }, { type: "text", text: " final " }] },
    ],
  };
  const service = new SubagentService({
    catalog,
    store,
    runtimeFactory: { start: vi.fn(async (invocation) => { invocations.push(invocation); return run; }) },
    toolFactory: () => undefined,
    persistOwnership: vi.fn(async (sessionId) => { ownership.push(sessionId); }),
    visibleSessionIds: () => ownership,
  });
  return { service, store, run, invocations, ownership, created, records };
}

describe("blocking subagent run", () => {
  it("creates ownership before runtime exposure, prompts with only the task, and returns the final text block", async () => {
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
      runtimeFactory: { start: vi.fn(async (invocation) => { order.push("start"); h.invocations.push(invocation); return h.run; }) },
      toolFactory: () => undefined,
      persistOwnership: vi.fn(async (id) => { order.push("own"); h.ownership.push(id); }),
      visibleSessionIds: () => h.ownership,
    });

    const result = await service.run({ agent: "worker", task: "Do exactly this" }, { cwd: "/project", creatorModel: { id: "creator" } });

    expect(order).toEqual(["create", "own", "start"]);
    expect(h.invocations[0]).toMatchObject({ definition: { name: "worker" }, record: { sessionId: "session-1" }, task: "Do exactly this" });
    expect(h.run.prompt).toHaveBeenCalledWith("Do exactly this");
    expect(result).toEqual({ sessionId: "session-1", result: " final " });
  });

  it("resumes a visible Session under any currently permitted Definition without adding ownership", async () => {
    const h = harness();
    h.records.set("session-old", { sessionId: "session-old", file: "/sessions/old.jsonl" });
    h.ownership.push("session-old");

    await h.service.run({ agent: "reviewer", task: "Review", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} });

    expect(h.store.create).not.toHaveBeenCalled();
    expect(h.invocations[0].definition.name).toBe("reviewer");
    expect(h.ownership).toEqual(["session-old"]);
  });

  it("rejects hidden and locked Sessions and releases a lock after failures", async () => {
    const h = harness({ fail: new Error("provider unavailable") });
    h.records.set("session-old", { sessionId: "session-old", file: "/sessions/old.jsonl" });
    h.ownership.push("session-old");

    const pending = h.service.run({ agent: "worker", task: "Fail", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} });
    await expect(h.service.run({ agent: "worker", task: "Again", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} })).rejects.toThrow("locked");
    await expect(pending).rejects.toThrow("Session session-old: provider unavailable");
    expect(h.run.dispose).toHaveBeenCalledOnce();

    h.run.prompt = vi.fn(async () => undefined);
    await expect(h.service.run({ agent: "worker", task: "Retry", sessionId: "session-old" }, { cwd: "/project", creatorModel: {} })).resolves.toBeDefined();
    await expect(h.service.run({ agent: "worker", task: "No", sessionId: "hidden" }, { cwd: "/project", creatorModel: {} })).rejects.toThrow("not a direct branch-visible child");
  });

  it("aborts the child from the tool signal and always disposes it", async () => {
    const h = harness();
    const controller = new AbortController();
    vi.mocked(h.run.prompt).mockImplementation(async () => new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));

    const pending = h.service.run({ agent: "worker", task: "Long" }, { cwd: "/project", creatorModel: {}, signal: controller.signal });
    await vi.waitFor(() => expect(h.run.prompt).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toThrow("Session session-1: cancelled");
    expect(h.run.abort).toHaveBeenCalledOnce();
    expect(h.run.dispose).toHaveBeenCalledOnce();
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
