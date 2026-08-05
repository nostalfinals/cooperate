import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DefinitionCatalog } from "../../src/catalog/definitions.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StructuredCoordinator } from "../../src/subagent/coordinator.ts";
import type { SubagentInvocation, SubagentRun } from "../../src/runtime/types.ts";
import type { SessionRecord, SessionStore } from "../../src/session/types.ts";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "../../src/session/ownership.ts";
import { SubagentService } from "../../src/subagent/service.ts";
import { createSubagentTool } from "../../src/tool/subagent-tool.ts";

const definition = (name: string, children: readonly string[] = []): AgentDefinition => ({
  name,
  description: name,
  tools: children.length > 0 ? ["subagent"] : [],
  subagentAgents: children,
  body: `${name} body`,
  filePath: `/defs/${name}.md`,
});

function createHarness(maxDepth = 3) {
  const catalog: DefinitionCatalog = {
    config: { maxDepth, gcOrphanSessions: true },
    definitions: [definition("parent", ["leaf"]), definition("leaf"), definition("forbidden")],
    configPath: "/config.json",
    definitionsPath: "/defs",
  };
  const records = new Map<string, SessionRecord>();
  const ownershipBySession = new Map<string, unknown[]>();
  const rootOwnership: string[] = [];
  const store: SessionStore = {
    create: vi.fn(async () => {
      const sessionId = `session-${records.size + 1}`;
      const entries: unknown[] = [];
      ownershipBySession.set(sessionId, entries);
      const native = {
        appendCustomEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
        getBranch: vi.fn(() => entries),
      };
      const record = { sessionId, file: `/${sessionId}.jsonl`, native };
      records.set(sessionId, record);
      return record;
    }),
    open: vi.fn(async (id) => records.get(id)!),
    list: vi.fn(async () => [...records.values()]),
    inspect: vi.fn(async () => ({ task: "task", result: "result" })),
  };
  const invocations: SubagentInvocation[] = [];
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const runtimeFactory = {
    start: vi.fn(async (invocation: SubagentInvocation): Promise<SubagentRun> => {
      invocations.push(invocation);
      return {
        prompt: vi.fn(async () => {
          if (invocation.definition.name === "parent") await parentGate;
        }),
        abort: vi.fn(),
        dispose: vi.fn(async () => undefined),
        messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: `${invocation.definition.name} result` }] }],
      };
    }),
  };
  const coordinator = new StructuredCoordinator(maxDepth, { generateId: (() => { let id = 0; return () => `${++id}`.padStart(8, "0"); })() });
  const service = new SubagentService({
    catalog,
    coordinator,
    toolFactory: createSubagentTool,
    store,
    runtimeFactory,
    persistOwnership: async (id) => { rootOwnership.push(id); },
    visibleSessionIds: () => rootOwnership,
  });
  return { catalog, coordinator, service, store, invocations, ownershipBySession, releaseParent };
}

async function executeNested(invocation: SubagentInvocation, params: Record<string, unknown>) {
  if (!invocation.subagentTool) throw new Error("missing nested tool");
  return (invocation.subagentTool as ToolDefinition).execute("call", params as never, undefined, undefined, {
    cwd: "/project",
    model: { id: "parent-model" },
  } as never);
}

describe("nested subagent runs", () => {
  it("installs a scoped tool that can create only a direct permitted child and persists ownership in the parent session", async () => {
    const h = createHarness();
    const parentPending = h.service.run({ agent: "parent", task: "parent task" }, { cwd: "/project", creatorModel: {} });
    await vi.waitFor(() => expect(h.invocations).toHaveLength(1));
    const parentInvocation = h.invocations[0]!;

    const nestedResult = await executeNested(parentInvocation, { action: "run", agent: "leaf", task: "leaf task" });
    expect(nestedResult.content).toEqual([{ type: "text", text: "leaf result" }]);
    expect(h.invocations[1]).toMatchObject({ definition: { name: "leaf" }, task: "leaf task" });
    const parentEntries = h.ownershipBySession.get(parentInvocation.record.sessionId)!;
    expect(ownedSessionIds(parentEntries)).toEqual([h.invocations[1]!.record.sessionId]);
    expect(parentEntries[0]).toMatchObject({ customType: OWNERSHIP_ENTRY });
    h.releaseParent();
    await parentPending;
  });

  it("rejects an unpermitted definition and over-depth run before session creation or locking", async () => {
    const h = createHarness(2);
    const parentPending = h.service.run({ agent: "parent", task: "parent task" }, { cwd: "/project", creatorModel: {} });
    await vi.waitFor(() => expect(h.invocations).toHaveLength(1));
    const parentInvocation = h.invocations[0]!;
    const createsBefore = vi.mocked(h.store.create).mock.calls.length;

    await expect(executeNested(parentInvocation, { action: "run", agent: "forbidden", task: "no" })).rejects.toThrow();
    await expect(executeNested(parentInvocation, { action: "run", agent: "leaf", task: "too deep" })).rejects.toThrow();
    expect(h.store.create).toHaveBeenCalledTimes(createsBefore);
    expect(h.coordinator.isSessionLocked("session-2")).toBe(false);
    h.releaseParent();
    await parentPending;
  });
});
