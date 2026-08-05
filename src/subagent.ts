import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createCallerCatalog, type AgentDefinition, type CallerCatalog, type DefinitionCatalog } from "./catalog.ts";
import { type CompletionNotice, type ContinuationHost, ContinuationRelay } from "./continuation.ts";
import { StructuredCoordinator, type SubagentSnapshot, type TerminalCause } from "./coordinator.ts";
import type { ChildRun, ChildRuntimeFactory } from "./runtime.ts";
import type { SessionRecord, SessionStore } from "./sessions.ts";
import { renderSubagentTree } from "./presentation.ts";
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
  onSnapshot?(snapshot: SubagentSnapshot): void;
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
  private readonly childServices = new Map<string, BlockingSubagentService>();
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
    this.childServices.set(subagentId, nestedService);
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
      this.childServices.delete(subagentId);
      const cause = { state: "failed", reason: errorMessage(error) } as const;
      this.coordinator.ownLoopEnded(subagentId, cause);
      await this.coordinator.finish(subagentId, cause);
      throw new Error(`Session ${record.sessionId}: ${errorMessage(error)}`, { cause: error });
    }

    this.coordinator.setRuntimeInfo(subagentId, {
      model: run.model ?? definition.model?.reference ?? "inherited",
      thinking: run.thinking ?? definition.thinking ?? "default",
    });
    this.coordinator.attachAbort(subagentId, () => run.abort());
    const emitSnapshot = () => {
      const snapshot = this.coordinator.snapshot(subagentId);
      if (snapshot) environment.onSnapshot?.(snapshot);
    };
    const unsubscribe = environment.onSnapshot ? this.coordinator.subscribe(emitSnapshot) : undefined;
    emitSnapshot();
    const outcomePromise = this.executeRun(subagentId, record, request.task, run, environment.signal)
      .then((outcome) => {
        environment.onSnapshot?.(outcome.snapshot);
        return outcome;
      })
      .finally(() => unsubscribe?.());
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
        .finally(() => {
          this.active.delete(subagentId);
          this.childServices.delete(subagentId);
        });
      void handle.done;
      return {
        sessionId: record.sessionId,
        subagentId,
        result: `started ${subagentId}\nsession ${record.sessionId}`,
      };
    }

    handle.done = outcomePromise.then(() => undefined).finally(() => {
      this.active.delete(subagentId);
      this.childServices.delete(subagentId);
    });
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

  snapshotRoots(): readonly SubagentSnapshot[] {
    return this.coordinator.snapshotRoots();
  }

  subscribe(listener: () => void): () => void {
    return this.coordinator.subscribe(listener);
  }

  async cancelFromUi(subagentId: string): Promise<void> {
    const owner = this.findOwner(subagentId);
    if (!owner) throw new Error(`Subagent '${subagentId}' is not active`);
    await owner.cancel(subagentId);
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

  private findOwner(subagentId: string): BlockingSubagentService | undefined {
    if (this.active.has(subagentId)) return this;
    for (const child of this.childServices.values()) {
      const owner = child.findOwner(subagentId);
      if (owner) return owner;
    }
    return undefined;
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

interface SubagentToolDetails {
  action: string;
  async?: boolean;
  subagentId?: string;
  sessionId?: string;
  count?: number;
  snapshot?: SubagentSnapshot;
}

function textResult(value: string, details: SubagentToolDetails): AgentToolResult<SubagentToolDetails> {
  return { content: [{ type: "text", text: truncateForTool(value) }], details };
}

function emptyResult(details: SubagentToolDetails): AgentToolResult<SubagentToolDetails> {
  return { content: [], details };
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
    async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const action = (params as { action: string }).action;
      if (action === "run") {
        const request = params as unknown as RunRequest;
        let latestSnapshot: SubagentSnapshot | undefined;
        const result = await service.run(request, {
          cwd: ctx.cwd,
          creatorModel: ctx.model,
          signal,
          toolCallId,
          onSnapshot: (snapshot) => {
            latestSnapshot = snapshot;
            onUpdate?.({
              content: [],
              details: { action, async: request.async === true, subagentId: snapshot.subagentId, sessionId: snapshot.sessionId, snapshot },
            });
          },
        });
        return textResult(result.result, {
          action,
          async: request.async === true,
          subagentId: result.subagentId,
          sessionId: result.sessionId,
          snapshot: latestSnapshot,
        });
      }
      if (action === "list-definitions") return textResult(caller.discovery, { action, count: caller.definitions.length });
      if (action === "list-subagents") {
        const entries = service.listSubagents();
        return textResult(JSON.stringify(entries, null, 2), { action, count: entries.length });
      }
      if (action === "list-sessions") {
        const entries = await service.listSessions();
        return textResult(JSON.stringify(entries, null, 2), { action, count: entries.length });
      }
      if (action === "wait") {
        await service.wait((params as unknown as { subagentIds: string[] }).subagentIds);
        return textResult("wait complete", { action });
      }
      if (action === "cancel") {
        await service.cancel((params as unknown as { subagentId: string }).subagentId);
        return emptyResult({ action });
      }
      throw new Error(`Unknown subagent action '${action}'`);
    },
    renderCall(args, theme) {
      const action = (args as { action: string }).action;
      let header = theme.fg("toolTitle", theme.bold(`subagent ${action}`));
      if (action === "run") {
        const run = args as unknown as RunRequest;
        header = theme.fg("toolTitle", theme.bold("subagent run ")) + theme.fg("accent", run.agent);
        if (run.async) header += theme.fg("muted", " (async)");
      } else if (action === "wait") {
        const ids = (args as unknown as { subagentIds: string[] }).subagentIds;
        header = theme.fg("toolTitle", theme.bold("subagent wait ")) + theme.fg("accent", ids.join(", "));
      } else if (action === "cancel") {
        const id = (args as unknown as { subagentId: string }).subagentId;
        header = theme.fg("toolTitle", theme.bold("subagent cancel ")) + theme.fg("accent", id);
      }
      return new Text(header, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as SubagentToolDetails | undefined;
      const renderState = context.state as { snapshot?: SubagentSnapshot } | undefined;
      if (details?.snapshot && renderState) renderState.snapshot = details.snapshot;
      const snapshot = details?.snapshot ?? renderState?.snapshot;
      const action = details?.action ?? (context.args as { action?: string }).action;
      const text = result.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (action === "run" && snapshot && !details?.async && !(context.args as { async?: boolean }).async) {
        return renderSubagentTree(snapshot, theme, options.expanded, text);
      }
      if (options.expanded) return new Text(text, 0, 0);
      if (details?.action === "run" && details.async && details.subagentId) {
        return new Text(theme.fg("success", `started ${details.subagentId}`), 0, 0);
      }
      if (details?.action === "list-subagents") {
        const count = details.count ?? 0;
        return new Text(theme.fg("muted", `${count} active subagent${count === 1 ? "" : "s"}`), 0, 0);
      }
      if (details?.action === "list-sessions") {
        const count = details.count ?? 0;
        return new Text(theme.fg("muted", `${count} session${count === 1 ? "" : "s"}`), 0, 0);
      }
      if (details?.action === "list-definitions") {
        const count = details.count ?? 0;
        return new Text(theme.fg("muted", `${count} definition${count === 1 ? "" : "s"}`), 0, 0);
      }
      if (action === "wait" || action === "cancel") return new Text("", 0, 0);
      return new Text(text, 0, 0);
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
