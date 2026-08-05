import { createCallerCatalog, type AgentDefinition, type DefinitionCatalog } from "../catalog.ts";
import { type CompletionNotice, type ContinuationHost, ContinuationRelay } from "../continuation.ts";
import { compactPreview, OWNERSHIP_ENTRY, ownedSessionIds, truncateForTool } from "../sessions.ts";
import type {
  ChildRun,
  ChildRuntimeFactory,
  SessionRecord,
  SessionStore,
  SubagentToolFactory,
} from "./ports.ts";
import { StructuredCoordinator } from "./coordinator.ts";
import { extractFinalText } from "./result.ts";
import type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot, TerminalCause } from "./types.ts";

export interface SubagentServiceOptions {
  catalog: DefinitionCatalog;
  store: SessionStore;
  runtimeFactory: ChildRuntimeFactory;
  toolFactory: SubagentToolFactory;
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

/** Caller-scoped service for blocking/async runs and direct-child management. */
export class SubagentService {
  private readonly options: SubagentServiceOptions;
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;
  private readonly coordinator: StructuredCoordinator;
  private readonly parentId?: string;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly childServices = new Map<string, SubagentService>();
  private continuation?: ContinuationHost;
  private disposed = false;

  constructor(options: SubagentServiceOptions) {
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
      ? this.options.toolFactory(nestedService, callerCatalog)
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

  private findOwner(subagentId: string): SubagentService | undefined {
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

  private createNestedService(record: SessionRecord, parentId: string, definition: AgentDefinition): SubagentService {
    const native = record.native as NativeOwnershipSession | undefined;
    return new SubagentService({
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
