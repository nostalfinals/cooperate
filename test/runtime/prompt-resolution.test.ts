import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/catalog/definitions.ts";
import type { CallerCatalog } from "../../src/catalog/types.ts";

import { PiChildRuntimeFactory, resolveSubagentModelConfig } from "../../src/runtime/runtime.ts";

const emptyCaller: CallerCatalog = {
  definitions: [],
  discovery: "No subagent is defined yet",
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
  it("prefers the definition model and thinking, otherwise creator model and global thinking then medium", () => {
    const explicit = { ...baseDefinition, model: { provider: "p", modelId: "m", reference: "p/m" }, thinking: "high" as const };
    const model = { provider: "p", id: "m" };
    expect(resolveSubagentModelConfig(explicit, { id: "creator" }, { getModel: () => model }, "low")).toEqual({ model, thinking: "high" });
    expect(resolveSubagentModelConfig(baseDefinition, { id: "creator" }, { getModel: () => undefined }, "low")).toEqual({ model: { id: "creator" }, thinking: "low" });
    expect(resolveSubagentModelConfig(baseDefinition, { id: "creator" }, { getModel: () => undefined }, undefined)).toEqual({ model: { id: "creator" }, thinking: "medium" });
  });

  it("fails when an invocation-time explicit model disappears or no creator model exists", () => {
    const explicit = { ...baseDefinition, model: { provider: "p", modelId: "gone", reference: "p/gone" } };
    expect(() => resolveSubagentModelConfig(explicit, {}, { getModel: () => undefined }, "medium")).toThrow();
    expect(() => resolveSubagentModelConfig(baseDefinition, undefined, { getModel: () => undefined }, "medium")).toThrow();
  });
});

describe("Pi child runtime adapter", () => {
  it("loads normal resources, appends the definition role block in the native slot, binds extensions, and activates exact tools", async () => {
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
      emptyCaller.discovery, "global", "project", expect.stringContaining("Definition body"),
    ]);
    expect(sessionOptions).toMatchObject({ model: { id: "creator" }, thinkingLevel: "low", tools: ["read", "custom"] });
    expect(run).toMatchObject({ model: "creator", thinking: "low" });
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
    expect(result?.content).toEqual([{ type: "text", text: emptyCaller.discovery }]);
  });

  it("adds an awaited agent_end hook for the child's structured descendant scope", async () => {
    let extensionFactories: Array<{ factory: (pi: any) => void }> | undefined;
    let endHandler: ((event: { messages: any[] }) => Promise<void>) | undefined;
    let release!: () => void;
    const scope = new Promise<void>((resolve) => { release = resolve; });
    const onAgentEnd = vi.fn(async () => scope);
    const session = {
      messages: [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async (options) => {
        extensionFactories = options.resourceLoaderOptions.extensionFactories as typeof extensionFactories;
        return { modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } };
      },
      createSession: async () => ({ session, dispose: async () => session.dispose() }),
    });

    await factory.start({
      cwd: "/project",
      definition: { ...baseDefinition, tools: [] },
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/id", native: {} },
      creatorModel: {},
      task: "task",
      onAgentEnd,
    });
    extensionFactories?.[0]?.factory({ on: (_event: string, handler: typeof endHandler) => { endHandler = handler; } });
    const pending = endHandler?.({ messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
    await vi.waitFor(() => expect(onAgentEnd).toHaveBeenCalledWith({ state: "finished" }));
    let settled = false;
    void pending?.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
  });

  it("wraps a nonblank append body in a role block and omits the block when blank", async () => {
    let resourceOptions: {
      appendSystemPromptOverride?: (base: string[]) => string[];
      extensionFactories?: Array<{ factory: (pi: any) => void }>;
    } | undefined;
    const session = {
      messages: [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async (options) => {
        resourceOptions = options.resourceLoaderOptions as typeof resourceOptions;
        return { modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } };
      },
      createSession: async () => ({ session, dispose: async () => session.dispose() }),
    });
    const start = (definition: AgentDefinition) => factory.start({
      cwd: "/project",
      definition,
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/id", native: {} },
      creatorModel: {},
      task: "task",
    });

    await start({ ...baseDefinition, tools: [], body: "Act as a focused worker." });
    expect(resourceOptions?.appendSystemPromptOverride?.(["global"])).toEqual([
      emptyCaller.discovery, "global", expect.stringContaining("Act as a focused worker."),
    ]);
    const handlers = new Map<string, (...args: any[]) => unknown>();
    resourceOptions?.extensionFactories?.[0]?.factory({ on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler) });
    expect(handlers.has("before_agent_start")).toBe(false);

    await start({ ...baseDefinition, tools: [], body: "   \n" });
    expect(resourceOptions?.appendSystemPromptOverride?.(["global"])).toEqual([
      emptyCaller.discovery, "global",
    ]);
  });

  it("replaces the entire system prompt with the definition body in override mode", async () => {
    let resourceOptions: {
      appendSystemPromptOverride?: (base: string[]) => string[];
      extensionFactories?: Array<{ factory: (pi: any) => void }>;
    } | undefined;
    const session = {
      messages: [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async (options) => {
        resourceOptions = options.resourceLoaderOptions as typeof resourceOptions;
        return { modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } };
      },
      createSession: async () => ({ session, dispose: async () => session.dispose() }),
    });

    await factory.start({
      cwd: "/project",
      definition: { ...baseDefinition, tools: [], systemPromptMode: "override", body: "Override text" },
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/id", native: {} },
      creatorModel: {},
      task: "task",
    });

    expect(resourceOptions?.appendSystemPromptOverride?.(["global", "project"])).toEqual(["global", "project"]);
    let startHandler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    resourceOptions?.extensionFactories?.[0]?.factory({
      on: (event: string, handler: typeof startHandler) => { if (event === "before_agent_start") startHandler = handler; },
    });
    expect(startHandler?.({ systemPrompt: "Base prompt\n\n<project_context>\ncontext\n</project_context>" })).toEqual({ systemPrompt: "Override text" });
  });

  it("allows an empty system prompt when the override body is blank", async () => {
    let resourceOptions: {
      appendSystemPromptOverride?: (base: string[]) => string[];
      extensionFactories?: Array<{ factory: (pi: any) => void }>;
    } | undefined;
    const session = {
      messages: [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      bindExtensions: vi.fn(async () => undefined),
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
    };
    const factory = new PiChildRuntimeFactory({
      createServices: async (options) => {
        resourceOptions = options.resourceLoaderOptions as typeof resourceOptions;
        return { modelRuntime: { getModel: () => undefined }, settingsManager: { getDefaultThinkingLevel: () => "medium" as const } };
      },
      createSession: async () => ({ session, dispose: async () => session.dispose() }),
    });

    await factory.start({
      cwd: "/project",
      definition: { ...baseDefinition, tools: [], systemPromptMode: "override", body: "" },
      callerCatalog: emptyCaller,
      record: { sessionId: "id", file: "/id", native: {} },
      creatorModel: {},
      task: "task",
    });

    let startHandler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    resourceOptions?.extensionFactories?.[0]?.factory({
      on: (event: string, handler: typeof startHandler) => { if (event === "before_agent_start") startHandler = handler; },
    });
    expect(startHandler?.({ systemPrompt: "Base prompt" })).toEqual({ systemPrompt: "" });
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

    await expect(factory.start({ cwd: "/project", agentDir: "/agent", definition: baseDefinition, callerCatalog: emptyCaller, record: { sessionId: "id", file: "/id", native: {} }, creatorModel: {}, task: "task" })).rejects.toThrow();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
