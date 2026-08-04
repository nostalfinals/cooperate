import { StringEnum } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, CallerCatalog } from "../src/catalog.ts";
import { PiChildRuntimeFactory, resolveInvocationSettings } from "../src/runtime.ts";

const emptyCaller: CallerCatalog = {
  definitions: [],
  discovery: "No subagent is defined yet",
  agentSchema: StringEnum([]),
};

const baseDefinition: AgentDefinition = {
  name: "worker",
  description: "Worker",
  tools: ["read", "custom"],
  subagentAgents: [],
  body: "Definition body",
  filePath: "/defs/worker.md",
};

describe("invocation prompt resolution", () => {
  it("prefers the Definition model and thinking, otherwise creator model and global thinking then medium", () => {
    const explicit = { ...baseDefinition, model: { provider: "p", modelId: "m", reference: "p/m" }, thinking: "high" as const };
    const model = { provider: "p", id: "m" };
    expect(resolveInvocationSettings(explicit, { id: "creator" }, { getModel: () => model }, "low")).toEqual({ model, thinking: "high" });
    expect(resolveInvocationSettings(baseDefinition, { id: "creator" }, { getModel: () => undefined }, "low")).toEqual({ model: { id: "creator" }, thinking: "low" });
    expect(resolveInvocationSettings(baseDefinition, { id: "creator" }, { getModel: () => undefined }, undefined)).toEqual({ model: { id: "creator" }, thinking: "medium" });
  });

  it("fails when an invocation-time explicit model disappears or no creator model exists", () => {
    const explicit = { ...baseDefinition, model: { provider: "p", modelId: "gone", reference: "p/gone" } };
    expect(() => resolveInvocationSettings(explicit, {}, { getModel: () => undefined }, "medium")).toThrow("p/gone");
    expect(() => resolveInvocationSettings(baseDefinition, undefined, { getModel: () => undefined }, "medium")).toThrow("creator has no current model");
  });
});

describe("Pi child runtime adapter", () => {
  it("loads normal resources, appends Definition body in the native slot, binds extensions, and activates exact tools", async () => {
    let resourceOptions: { appendSystemPromptOverride?: (base: string[]) => string[] } | undefined;
    let sessionOptions: Record<string, unknown> | undefined;
    const messages: unknown[] = [{ role: "user", content: "history" }];
    const session = {
      messages,
      getAllTools: () => [{ name: "read" }, { name: "custom" }, { name: "extra" }],
      getActiveToolNames: () => ["read", "custom"],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(async (task: string) => { messages.push({ role: "user", content: task }); }),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const services = {
      modelRuntime: { getModel: () => undefined },
      settingsManager: { getDefaultThinkingLevel: () => "low" as const },
    };
    const factory = new PiChildRuntimeFactory({
      createServices: vi.fn(async (options) => { resourceOptions = options.resourceLoaderOptions; return services; }),
      createSession: vi.fn(async (options) => {
        sessionOptions = options as unknown as Record<string, unknown>;
        return { session, dispose: async () => session.dispose() };
      }),
    });

    const run = await factory.start({
      cwd: "/project",
      agentDir: "/agent",
      definition: baseDefinition,
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/sessions/id.jsonl", native: {} },
      creatorModel: { id: "creator" },
      task: "isolated task",
    });

    expect(resourceOptions?.appendSystemPromptOverride?.(["global", "project"])).toEqual([
      "No subagent is defined yet", "global", "project", "Definition body",
    ]);
    expect(sessionOptions).toMatchObject({ model: { id: "creator" }, thinkingLevel: "low", tools: ["read", "custom"] });
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    await run.prompt("isolated task");
    expect(session.prompt).toHaveBeenCalledWith("isolated task");
    expect(run.messagesSinceStart()).toEqual([{ role: "user", content: "isolated task" }]);

    session.prompt.mockImplementationOnce(async () => {
      messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "model failed" });
    });
    await expect(run.prompt("fails")).rejects.toThrow("model failed");
  });

  it("overrides a child's subagent tool with its caller-scoped discovery action", async () => {
    let customTools: Array<{ execute: (...args: any[]) => Promise<{ content: unknown[] }> }> | undefined;
    const session = {
      messages: [],
      getAllTools: () => [{ name: "subagent" }],
      getActiveToolNames: () => ["subagent"],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async () => ({ modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } }),
      createSession: async (input) => {
        customTools = input.customTools as typeof customTools;
        return { session, dispose: async () => session.dispose() };
      },
    });

    await factory.start({
      cwd: "/project",
      definition: { ...baseDefinition, tools: ["subagent"] },
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/id", native: {} },
      creatorModel: {},
      task: "task",
    });

    expect(customTools).toHaveLength(1);
    const result = await customTools?.[0]?.execute("call", { action: "list-definitions" }, undefined, undefined, { cwd: "/project" });
    expect(result?.content).toEqual([{ type: "text", text: "No subagent is defined yet" }]);
  });

  it("fails before prompting if any configured tool is unavailable or exact activation is weakened", async () => {
    const session = {
      messages: [],
      getAllTools: () => [{ name: "read" }],
      getActiveToolNames: () => ["read"],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async () => ({ modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } }),
      createSession: async () => ({ session, dispose: async () => session.dispose() }),
    });

    await expect(factory.start({ cwd: "/project", agentDir: "/agent", definition: baseDefinition, callerCatalog: emptyCaller, record: { sessionId: "id", file: "/id", native: {} }, creatorModel: {}, task: "task" })).rejects.toThrow("unavailable configured tool 'custom'");
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
