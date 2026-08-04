import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, type AgentDefinition, type CallerCatalog, type DefinitionCatalog } from "./catalog.ts";
import { StructuredCoordinator, type TerminalCause } from "./coordinator.ts";
import type { ChildRun, ChildRuntimeFactory } from "./runtime.ts";
import type { SessionRecord, SessionStore } from "./sessions.ts";
import { compactPreview, OWNERSHIP_ENTRY, ownedSessionIds, truncateForTool } from "./sessions.ts";

export interface RunRequest {
  agent: string;
  task: string;
  sessionId?: string;
  async?: boolean;
}

export interface RunEnvironment {
  cwd: string;
  creatorModel: unknown;
  signal?: AbortSignal;
}

export interface BlockingSubagentOptions {
  catalog: DefinitionCatalog;
  store: SessionStore;
  runtimeFactory: ChildRuntimeFactory;
  persistOwnership(sessionId: string): Promise<void>;
  visibleSessionIds(): readonly string[];
  agentDir?: string;
  coordinator?: StructuredCoordinator;
  parentId?: string;
  allowedDefinitions?: readonly string[];
}

interface NativeOwnershipSession {
  appendCustomEntry(customType: string, data?: unknown): unknown;
  getBranch(): readonly unknown[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractFinalText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text;
      }
    }
    return "<none>";
  }
  return "<none>";
}

export class BlockingSubagentService {
  private readonly options: BlockingSubagentOptions;
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;
  private readonly coordinator: StructuredCoordinator;
  private readonly parentId?: string;
  private disposed = false;

  constructor(options: BlockingSubagentOptions) {
    this.options = options;
    this.coordinator = options.coordinator ?? new StructuredCoordinator(options.catalog.config.maxDepth);
    this.parentId = options.parentId;
    const allowed = options.allowedDefinitions ? new Set(options.allowedDefinitions) : undefined;
    this.definitions = new Map(options.catalog.definitions
      .filter((definition) => !allowed || allowed.has(definition.name))
      .map((definition) => [definition.name, definition]));
  }

  async run(request: RunRequest, environment: RunEnvironment): Promise<{ sessionId: string; result: string }> {
    if (this.disposed) throw new Error("subagent runtime is shutting down");
    if (request.async) throw new Error("asynchronous subagents are not implemented in this slice");
    const definition = this.definitions.get(request.agent);
    if (!definition) throw new Error(`Definition '${request.agent}' is not available to this caller`);
    if (request.task.trim().length === 0) throw new Error("task must be nonempty");
    // Depth is knowable before touching durable Session state and must win over
    // creation, ownership, and locking side effects.
    this.coordinator.assertCanStart(this.parentId);

    let record: SessionRecord;
    if (request.sessionId) {
      if (!this.options.visibleSessionIds().includes(request.sessionId)) {
        throw new Error(`Session '${request.sessionId}' is not a direct branch-visible child`);
      }
      if (this.coordinator.isSessionLocked(request.sessionId)) throw new Error(`Session '${request.sessionId}' is locked`);
      record = await this.options.store.open(request.sessionId);
    } else {
      record = await this.options.store.create();
      await this.options.persistOwnership(record.sessionId);
    }

    if (definition.tools.includes("subagent") && !record.native) {
      throw new Error("child Session record has no native SessionManager for nested ownership");
    }
    const started = this.coordinator.start({
      parentId: this.parentId,
      sessionId: record.sessionId,
      agent: definition.name,
      task: request.task,
    });
    const subagentId = started.subagentId;
    const callerCatalog = createCallerCatalog(this.options.catalog, definition.subagentAgents);
    const nestedService = this.createNestedService(record, subagentId, definition);
    const nestedTool = definition.tools.includes("subagent")
      ? createSubagentTool(nestedService, callerCatalog)
      : undefined;

    let run: ChildRun | undefined;
    let cause: TerminalCause = { state: "finished" };
    const abortFromSignal = () => this.coordinator.requestCancel(subagentId, "caller aborted");
    if (environment.signal?.aborted) abortFromSignal();
    environment.signal?.addEventListener("abort", abortFromSignal, { once: true });
    try {
      run = await this.options.runtimeFactory.start({
        cwd: environment.cwd,
        agentDir: this.options.agentDir,
        definition,
        callerCatalog,
        record,
        creatorModel: environment.creatorModel,
        task: request.task,
        subagentTool: nestedTool,
        onAgentEnd: async (terminal) => {
          this.coordinator.ownLoopEnded(subagentId, terminal);
          await this.coordinator.waitForDescendants(subagentId);
        },
      });
      this.coordinator.attachAbort(subagentId, () => run?.abort());
      await run.prompt(request.task);
      this.coordinator.ownLoopEnded(subagentId, cause);
      return {
        sessionId: record.sessionId,
        result: truncateForTool(extractFinalText(run.messagesSinceStart())),
      };
    } catch (error) {
      cause = { state: "failed", reason: errorMessage(error) };
      this.coordinator.ownLoopEnded(subagentId, cause);
      throw new Error(`Session ${record.sessionId}: ${errorMessage(error)}`, { cause: error });
    } finally {
      environment.signal?.removeEventListener("abort", abortFromSignal);
      try {
        await run?.dispose();
      } finally {
        await this.coordinator.finish(subagentId, cause);
      }
    }
  }

  listSubagents(): readonly Record<string, unknown>[] {
    return this.coordinator.directChildren(this.parentId).map((binding) => ({
      subagentId: binding.subagentId,
      agent: binding.agent,
      session: binding.sessionId,
      task: compactPreview(binding.task),
      state: binding.state,
      elapsedMs: binding.elapsedMs,
    }));
  }

  async listSessions(): Promise<readonly Record<string, unknown>[]> {
    const visible = new Set(this.options.visibleSessionIds());
    const records = (await this.options.store.list()).filter((record) => visible.has(record.sessionId));
    return Promise.all(records.map(async (record) => {
      const inspection = await this.options.store.inspect(record);
      return {
        session: record.sessionId,
        locked: this.coordinator.isSessionLocked(record.sessionId),
        task: inspection.task,
        result: inspection.result,
        file: record.file,
      };
    }));
  }

  waitForDescendants(): Promise<void> {
    return this.coordinator.waitForDescendants(this.parentId);
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parentId) {
      for (const child of this.coordinator.directChildren(this.parentId)) {
        this.coordinator.requestCancel(child.subagentId, "runtime shutting down");
      }
      await this.coordinator.waitForDescendants(this.parentId);
    } else {
      await this.coordinator.cancelAll("runtime shutting down");
    }
  }

  private createNestedService(record: SessionRecord, parentId: string, definition: AgentDefinition): BlockingSubagentService {
    const native = record.native as NativeOwnershipSession | undefined;
    return new BlockingSubagentService({
      ...this.options,
      coordinator: this.coordinator,
      parentId,
      allowedDefinitions: definition.subagentAgents,
      persistOwnership: async (sessionId) => {
        native?.appendCustomEntry(OWNERSHIP_ENTRY, { sessionId });
      },
      visibleSessionIds: () => native ? ownedSessionIds(native.getBranch()) : [],
    });
  }
}

const actionSchema = (agentSchema: TSchema) => Type.Union([
  Type.Object({
    action: Type.Literal("run"),
    agent: agentSchema,
    task: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(Type.String()),
    async: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list-definitions") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list-subagents") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list-sessions") }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("wait"),
    subagentIds: Type.Array(Type.String({ pattern: "^[0-9a-f]{8}$" }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("cancel"),
    subagentId: Type.String({ pattern: "^[0-9a-f]{8}$" }),
  }, { additionalProperties: false }),
], {
  // Some OpenAI-compatible providers (including DeepSeek V4 Flash)
  // require function parameter schemas to declare a top-level object type.
  // Keep the discriminated anyOf while making that object contract explicit.
  type: "object",
});

function textResult(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: truncateForTool(value) }], details: undefined };
}

interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<{ sessionId: string; result: string }>;
  listSubagents(): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
}

export function createSubagentTool(
  service: SubagentToolService,
  caller: CallerCatalog,
): ToolDefinition {
  return {
    name: "subagent",
    label: "subagent",
    description: "Run and manage configured subagents and their Sessions.",
    parameters: actionSchema(caller.agentSchema),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const action = (params as { action: string }).action;
      if (action === "run") {
        const request = params as unknown as RunRequest;
        const result = await service.run(request, { cwd: ctx.cwd, creatorModel: ctx.model, signal });
        return textResult(result.result);
      }
      if (action === "list-definitions") return textResult(caller.discovery);
      if (action === "list-subagents") return textResult(JSON.stringify(service.listSubagents(), null, 2));
      if (action === "list-sessions") return textResult(JSON.stringify(await service.listSessions(), null, 2));
      throw new Error(`subagent action '${action}' is not implemented until the asynchronous coordination slice`);
    },
  };
}

export function createSubagentDiscoveryTool(caller: CallerCatalog): ToolDefinition {
  const unavailable = (): never => {
    throw new Error("nested subagent coordination is not implemented in this slice");
  };
  return createSubagentTool({
    run: async () => unavailable(),
    listSubagents: unavailable,
    listSessions: async () => unavailable(),
  }, caller);
}
