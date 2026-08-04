import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, type AgentDefinition, type CallerCatalog, type DefinitionCatalog } from "./catalog.ts";
import { type CompletionNotice, type ContinuationHost, ContinuationRelay } from "./continuation.ts";
import { StructuredCoordinator, type SubagentSnapshot, type TerminalCause } from "./coordinator.ts";
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
  toolCallId?: string;
}

export interface RunResponse {
  sessionId: string;
  result: string;
  subagentId?: string;
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
  continuation?: ContinuationHost;
}

interface NativeOwnershipSession {
  appendCustomEntry(customType: string, data?: unknown): unknown;
  getBranch(): readonly unknown[];
}

interface ExecutionOutcome {
  snapshot: SubagentSnapshot;
  result?: string;
  error?: Error;
}

interface ActiveExecution {
  readonly async: boolean;
  explicitCancel: boolean;
  suppressNotification: boolean;
  notificationSuppressed: Promise<void>;
  resolveNotificationSuppressed(): void;
  done: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAbortedAgentEnd(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
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

/** Caller-scoped service for blocking/async runs and direct-child management. */
export class BlockingSubagentService {
  private readonly options: BlockingSubagentOptions;
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;
  private readonly coordinator: StructuredCoordinator;
  private readonly parentId?: string;
  private readonly active = new Map<string, ActiveExecution>();
  private continuation?: ContinuationHost;
  private disposed = false;

  constructor(options: BlockingSubagentOptions) {
    this.options = options;
    this.coordinator = options.coordinator ?? new StructuredCoordinator(options.catalog.config.maxDepth);
    this.parentId = options.parentId;
    this.continuation = options.continuation;
    const allowed = options.allowedDefinitions ? new Set(options.allowedDefinitions) : undefined;
    this.definitions = new Map(options.catalog.definitions
      .filter((definition) => !allowed || allowed.has(definition.name))
      .map((definition) => [definition.name, definition]));
  }

  bindContinuationHost(host: ContinuationHost): void {
    if (this.continuation instanceof ContinuationRelay) this.continuation.bind(host);
    else this.continuation = host;
  }

  async run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse> {
    if (this.disposed) throw new Error("subagent runtime is shutting down");
    const definition = this.definitions.get(request.agent);
    if (!definition) throw new Error(`Definition '${request.agent}' is not available to this caller`);
    if (request.task.trim().length === 0) throw new Error("task must be nonempty");
    if (request.async && !this.continuation) {
      throw new Error("asynchronous subagent startup requires a bound continuation");
    }
    // Depth must win over Session creation, ownership, and locking side effects.
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

    let run: ChildRun;
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
        onContinuationHost: (host) => nestedService.bindContinuationHost(host),
        onAgentEnd: async (terminal) => {
          this.coordinator.ownLoopEnded(subagentId, terminal);
          await this.coordinator.waitForDescendants(subagentId);
        },
      });
    } catch (error) {
      const cause = { state: "failed", reason: errorMessage(error) } as const;
      this.coordinator.ownLoopEnded(subagentId, cause);
      await this.coordinator.finish(subagentId, cause);
      throw new Error(`Session ${record.sessionId}: ${errorMessage(error)}`, { cause: error });
    }

    this.coordinator.attachAbort(subagentId, () => run.abort());
    const outcomePromise = this.executeRun(subagentId, record, request.task, run, environment.signal);
    let resolveNotificationSuppressed!: () => void;
    const notificationSuppressed = new Promise<void>((resolve) => { resolveNotificationSuppressed = resolve; });
    const handle: ActiveExecution = {
      async: request.async === true,
      explicitCancel: false,
      suppressNotification: false,
      notificationSuppressed,
      resolveNotificationSuppressed,
      done: Promise.resolve(),
    };
    this.active.set(subagentId, handle);

    if (request.async) {
      const startupCommitted = environment.toolCallId
        ? this.continuation!.waitForStartupCommit(environment.toolCallId)
        : Promise.resolve();
      handle.done = this.completeAsync(handle, outcomePromise, startupCommitted)
        .finally(() => { this.active.delete(subagentId); });
      void handle.done;
      return {
        sessionId: record.sessionId,
        subagentId,
        result: `started ${subagentId}\nsession ${record.sessionId}`,
      };
    }

    handle.done = outcomePromise.then(() => undefined).finally(() => { this.active.delete(subagentId); });
    const outcome = await outcomePromise;
    await handle.done;
    if (outcome.error || outcome.snapshot.state !== "finished") {
      throw new Error(`Session ${record.sessionId}: ${outcome.error?.message ?? outcome.snapshot.reason ?? outcome.snapshot.state}`, { cause: outcome.error });
    }
    return { sessionId: record.sessionId, result: outcome.result ?? "<none>" };
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

  async wait(subagentIds: readonly string[]): Promise<void> {
    if (subagentIds.length === 0) throw new Error("subagentIds must be nonempty");
    if (new Set(subagentIds).size !== subagentIds.length) throw new Error("subagentIds must be unique");
    const handles = this.captureDirect(subagentIds);
    await Promise.all(handles.map((handle) => handle.done));
  }

  async cancel(subagentId: string): Promise<void> {
    const [handle] = this.captureDirect([subagentId]);
    handle!.explicitCancel = true;
    this.coordinator.requestCancel(subagentId, "explicitly cancelled");
    await handle!.done;
  }

  waitForDescendants(): Promise<void> {
    return this.coordinator.waitForDescendants(this.parentId);
  }

  async cancelActive(reason: string): Promise<void> {
    for (const handle of this.active.values()) {
      handle.suppressNotification = true;
      handle.resolveNotificationSuppressed();
    }
    if (this.parentId) {
      for (const child of this.coordinator.directChildren(this.parentId)) {
        this.coordinator.requestCancel(child.subagentId, reason);
      }
      await this.coordinator.waitForDescendants(this.parentId);
    } else {
      await this.coordinator.cancelAll(reason);
    }
    await Promise.all([...this.active.values()].map((handle) => handle.done));
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancelActive("runtime shutting down");
  }

  private captureDirect(ids: readonly string[]): ActiveExecution[] {
    const direct = new Set(this.coordinator.directChildren(this.parentId).map((child) => child.subagentId));
    return ids.map((id) => {
      const handle = this.active.get(id);
      if (!direct.has(id) || !handle) throw new Error(`Subagent '${id}' is not an active direct child`);
      return handle;
    });
  }

  private async executeRun(
    subagentId: string,
    record: SessionRecord,
    task: string,
    run: ChildRun,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    let cause: TerminalCause = { state: "finished" };
    let result: string | undefined;
    let caught: Error | undefined;
    const abortFromSignal = () => this.coordinator.requestCancel(subagentId, "caller aborted");
    if (signal?.aborted) abortFromSignal();
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    try {
      await run.prompt(task);
      result = truncateForTool(extractFinalText(run.messagesSinceStart()));
      this.coordinator.ownLoopEnded(subagentId, cause);
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
      cause = { state: "failed", reason: caught.message };
      this.coordinator.ownLoopEnded(subagentId, cause);
    } finally {
      signal?.removeEventListener("abort", abortFromSignal);
      try {
        await run.dispose();
      } catch (error) {
        if (!caught) {
          caught = error instanceof Error ? error : new Error(String(error));
          cause = { state: "failed", reason: caught.message };
          this.coordinator.ownLoopEnded(subagentId, cause);
        }
      }
    }
    const snapshot = await this.coordinator.finish(subagentId, cause);
    if (!snapshot) throw new Error(`Subagent '${subagentId}' completed without a terminal snapshot`);
    return { snapshot, result, error: caught };
  }

  private async completeAsync(
    handle: ActiveExecution,
    outcomePromise: Promise<ExecutionOutcome>,
    startupCommitted: Promise<void>,
  ): Promise<void> {
    const outcome = await outcomePromise;
    await Promise.race([startupCommitted, handle.notificationSuppressed]);
    const { snapshot } = outcome;
    if (snapshot.state === "running" || snapshot.state === "waiting") {
      throw new Error(`Subagent '${snapshot.subagentId}' has a nonterminal completion snapshot`);
    }
    if (handle.suppressNotification) return;
    if (snapshot.state === "cancelled" && !handle.explicitCancel) return;
    const notice: CompletionNotice = {
      agent: snapshot.agent,
      state: snapshot.state,
      sessionId: snapshot.sessionId,
      elapsedMs: snapshot.elapsedMs,
      ...(snapshot.state === "finished"
        ? { result: outcome.result ?? "<none>" }
        : { reason: snapshot.reason ?? outcome.error?.message ?? snapshot.state }),
    };
    await this.continuation!.send(notice);
  }

  private createNestedService(record: SessionRecord, parentId: string, definition: AgentDefinition): BlockingSubagentService {
    const native = record.native as NativeOwnershipSession | undefined;
    return new BlockingSubagentService({
      ...this.options,
      coordinator: this.coordinator,
      parentId,
      allowedDefinitions: definition.subagentAgents,
      continuation: new ContinuationRelay(),
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
], { type: "object" });

function textResult(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: truncateForTool(value) }], details: undefined };
}

function emptyResult(): AgentToolResult<undefined> {
  return { content: [], details: undefined };
}

interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  wait(subagentIds: readonly string[]): Promise<void>;
  cancel(subagentId: string): Promise<void>;
}

export function createSubagentTool(service: SubagentToolService, caller: CallerCatalog): ToolDefinition {
  return {
    name: "subagent",
    label: "subagent",
    description: "Run and manage configured subagents and their Sessions.",
    parameters: actionSchema(caller.agentSchema),
    async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const action = (params as { action: string }).action;
      if (action === "run") {
        const request = params as unknown as RunRequest;
        const result = await service.run(request, { cwd: ctx.cwd, creatorModel: ctx.model, signal, toolCallId });
        return textResult(result.result);
      }
      if (action === "list-definitions") return textResult(caller.discovery);
      if (action === "list-subagents") return textResult(JSON.stringify(service.listSubagents(), null, 2));
      if (action === "list-sessions") return textResult(JSON.stringify(await service.listSessions(), null, 2));
      if (action === "wait") {
        await service.wait((params as unknown as { subagentIds: string[] }).subagentIds);
        return textResult("wait complete");
      }
      if (action === "cancel") {
        await service.cancel((params as unknown as { subagentId: string }).subagentId);
        return emptyResult();
      }
      throw new Error(`Unknown subagent action '${action}'`);
    },
  };
}

export function createSubagentDiscoveryTool(caller: CallerCatalog): ToolDefinition {
  const unavailable = (): never => { throw new Error("nested subagent coordination is unavailable"); };
  return createSubagentTool({
    run: async () => unavailable(),
    listSubagents: unavailable,
    listSessions: async () => unavailable(),
    wait: async () => unavailable(),
    cancel: async () => unavailable(),
  }, caller);
}
