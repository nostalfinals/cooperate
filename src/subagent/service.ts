import { createCallerCatalog } from "../catalog/catalog.ts";
import { includesEntry, isWildcard, resolveEntries, type AgentDefinition, type DefinitionCatalog } from "../catalog/definitions.ts";
import { type CompletionNotice, type Messenger, DeferredMessenger } from "./messenger.ts";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "../session/ownership.ts";
import { compactPreview, truncateForTool } from "../text.ts";
import type { SessionRecord, SessionStore } from "../session/types.ts";
import type { ChildRuntimeFactory, SubagentRun } from "../runtime/types.ts";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { SubagentToolFactory } from "../tool/types.ts";
import { StructuredCoordinator } from "./coordinator.ts";
import { completionTitle, extractFinalText } from "./result.ts";
import type { RunEnvironment, RunRequest, RunResponse, SubagentActivity, SubagentSnapshot, TerminalCause } from "./types.ts";

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
  messenger?: Messenger;
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
  private readonly runs = new Map<string, SubagentRun>();
  private readonly records: Map<string, SessionRecord>;
  private messenger?: Messenger;
  private disposed = false;

  constructor(options: SubagentServiceOptions, records = new Map<string, SessionRecord>()) {
    this.options = options;
    this.records = records;
    this.coordinator = options.coordinator ?? new StructuredCoordinator(options.catalog.config.maxDepth);
    this.parentId = options.parentId;
    this.messenger = options.messenger;
    const allowed = options.allowedDefinitions ? new Set(options.allowedDefinitions) : undefined;
    this.definitions = new Map(options.catalog.definitions
      .filter((definition) => !allowed || allowed.has(definition.name))
      .map((definition) => [definition.name, definition]));
  }

  bindMessenger(messenger: Messenger): void {
    if (this.messenger instanceof DeferredMessenger) this.messenger.bind(messenger);
    else this.messenger = messenger;
  }

  async run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse> {
    if (this.disposed) throw new Error("subagent runtime is shutting down");
    const definition = this.definitions.get(request.agent);
    if (!definition) throw new Error(`Definition '${request.agent}' is not available to this caller`);
    if (request.task.trim().length === 0) throw new Error("task must be nonempty");
    if (request.prompt.trim().length === 0) throw new Error("prompt must be nonempty");
    if (request.async && !this.messenger) {
      throw new Error("asynchronous subagent startup requires a bound messenger");
    }
    // Depth must win over session creation, ownership, and locking side effects.
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

    if (includesEntry(definition.tools, "subagent") && !record.native) {
      throw new Error("child session record has no native SessionManager for nested ownership");
    }
    const started = this.coordinator.start({
      parentId: this.parentId,
      sessionId: record.sessionId,
      agent: definition.name,
      task: request.task,
    });
    const subagentId = started.subagentId;
    const unrestrictedChildren = isWildcard(definition.subagentAgents);
    const allowedNames = unrestrictedChildren
      ? undefined
      : resolveEntries(definition.subagentAgents, this.options.catalog.definitions.map((item) => item.name));
    const callerCatalog = createCallerCatalog(this.options.catalog, allowedNames);
    const nestedService = this.createNestedService(record, subagentId, allowedNames);
    this.childServices.set(subagentId, nestedService);
    const nestedTool = includesEntry(definition.tools, "subagent")
      ? this.options.toolFactory(nestedService, callerCatalog)
      : undefined;

    let run: SubagentRun;
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
        onMessenger: (messenger) => nestedService.bindMessenger(messenger),
        onAgentEnd: async (terminal) => {
          this.coordinator.ownLoopEnded(subagentId, terminal);
          // A failed agent_end may be a transient provider error that pi's auto-retry
          // recovers from within this same prompt() call. Descendants (e.g. background
          // async children) must neither be cancelled nor awaited here; only the
          // confirmed-failure path in executeRun cancels them.
          if (terminal.state !== "failed") await this.coordinator.waitForDescendants(subagentId);
        },
        onActivity: (activity) => this.coordinator.setActivity(subagentId, activity),
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
    this.runs.set(subagentId, run);
    this.records.set(subagentId, record);
    const emitSnapshot = () => {
      const snapshot = this.coordinator.snapshot(subagentId);
      if (snapshot) environment.onSnapshot?.(snapshot);
    };
    const unsubscribe = environment.onSnapshot ? this.coordinator.subscribe(emitSnapshot) : undefined;
    emitSnapshot();
    const outcomePromise = this.executeRun(subagentId, record, request.prompt, run, environment.signal)
      .then((outcome) => {
        environment.onSnapshot?.(outcome.snapshot);
        return outcome;
      })
      .finally(() => {
        this.runs.delete(subagentId);
        unsubscribe?.();
      });
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
        ? this.messenger!.waitForStartupCommit(environment.toolCallId)
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
        result: `Started background subagent ${request.agent} (subagentId=${subagentId}, sessionId=${record.sessionId})`,
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
    return {
      sessionId: record.sessionId,
      subagentId,
      result: `${completionTitle(request.agent, "finished", subagentId, record.sessionId)}\n\n${outcome.result ?? "<none>"}`,
    };
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

  async wait(
    subagentIds: readonly string[],
    onSnapshot?: (snapshots: readonly SubagentSnapshot[]) => void,
  ): Promise<void> {
    if (subagentIds.length === 0) throw new Error("subagentIds must be nonempty");
    if (new Set(subagentIds).size !== subagentIds.length) throw new Error("subagentIds must be unique");
    const handles = this.captureDirect(subagentIds);
    const emit = () => onSnapshot?.(this.snapshotsFor(subagentIds));
    const unsubscribe = onSnapshot ? this.coordinator.subscribe(emit) : undefined;
    emit();
    try {
      await Promise.all(handles.map((handle) => handle.done));
    } finally {
      unsubscribe?.();
    }
  }

  async cancel(subagentId: string): Promise<SubagentSnapshot | undefined> {
    const [handle] = this.captureDirect([subagentId]);
    handle!.explicitCancel = true;
    handle!.resolveNotificationSuppressed();
    this.coordinator.requestCancel(subagentId, "cancelled by user");
    await handle!.done;
    return this.coordinator.snapshotOrLast(subagentId);
  }

  snapshotsFor(ids: readonly string[]): readonly SubagentSnapshot[] {
    return ids
      .map((id) => this.coordinator.snapshotOrLast(id))
      .filter((snapshot): snapshot is SubagentSnapshot => snapshot !== undefined);
  }

  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined {
    return this.coordinator.snapshotOrLast(subagentId);
  }

  getToolDefinition(subagentId: string, toolName: string): unknown {
    const owner = this.findRunOwner(subagentId);
    return owner?.runs.get(subagentId)?.getToolDefinition?.(toolName);
  }

  getTree(subagentId: string): readonly SessionTreeNode[] | undefined {
    const native = this.records.get(subagentId)?.native;
    if (!native || typeof native !== "object" || !("getTree" in native)) return undefined;
    return (native as { getTree(): SessionTreeNode[] }).getTree();
  }

  async steer(subagentId: string, text: string): Promise<void> {
    const owner = this.findRunOwner(subagentId);
    await owner?.runs.get(subagentId)?.steer?.(text);
  }

  getSteeringMessages(subagentId: string): readonly string[] {
    const owner = this.findRunOwner(subagentId);
    return owner?.runs.get(subagentId)?.getSteeringMessages?.() ?? [];
  }

  async replaceSteering(subagentId: string, text: string): Promise<void> {
    const owner = this.findRunOwner(subagentId);
    const run = owner?.runs.get(subagentId);
    if (!run) return;
    run.clearSteering?.();
    await run.steer?.(text);
  }

  clearCompleted(): void {
    for (const id of this.coordinator.completedIds()) this.records.delete(id);
    this.coordinator.clearCompleted();
    for (const child of this.childServices.values()) child.clearCompleted();
  }

  waitForDescendants(): Promise<void> {
    return this.coordinator.waitForDescendants(this.parentId);
  }

  snapshotRoots(): readonly SubagentSnapshot[] {
    return this.coordinator.snapshotRoots();
  }

  snapshotOf(subagentId: string): SubagentSnapshot | undefined {
    return this.coordinator.snapshotOrLast(subagentId);
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

  private findRunOwner(subagentId: string): SubagentService | undefined {
    if (this.runs.has(subagentId)) return this;
    for (const child of this.childServices.values()) {
      const owner = child.findRunOwner(subagentId);
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
    run: SubagentRun,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    let cause: TerminalCause = { state: "finished" };
    let result: string | undefined;
    let caught: Error | undefined;
    const abortFromSignal = () => this.coordinator.requestCancel(subagentId, "invoker was cancelled");
    if (signal?.aborted) abortFromSignal();
    signal?.addEventListener("abort", abortFromSignal, { once: true });
    try {
      await run.prompt(task);
      result = truncateForTool(extractFinalText(run.messagesSinceStart()));
      // prompt() resolving means the final assistant turn succeeded; if pi's auto-retry
      // emitted a transient error agent_end mid-run (e.g. fetch failed), the stale failed
      // cause must not override the actual finished outcome at finish() time.
      this.coordinator.recoverAsFinished(subagentId);
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
    // A confirmed failure (retries exhausted) must stop still-running descendants;
    // a transient agent_end failure that pi's auto-retry recovered from must not.
    if (cause.state === "failed") {
      this.coordinator.cancelDescendants(subagentId, cause.reason);
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
      subagentId: snapshot.subagentId,
      sessionId: snapshot.sessionId,
      task: snapshot.task,
      elapsedMs: snapshot.elapsedMs,
      ...(snapshot.state === "finished"
        ? { result: outcome.result ?? "<none>" }
        : { reason: snapshot.reason ?? outcome.error?.message ?? snapshot.state }),
    };
    await this.messenger!.send(notice);
  }

  private createNestedService(
    record: SessionRecord,
    parentId: string,
    allowedNames: readonly string[] | undefined,
  ): SubagentService {
    const native = record.native as NativeOwnershipSession | undefined;
    return new SubagentService({
      ...this.options,
      coordinator: this.coordinator,
      parentId,
      allowedDefinitions: allowedNames,
      messenger: new DeferredMessenger(),
      persistOwnership: async (sessionId) => {
        native?.appendCustomEntry(OWNERSHIP_ENTRY, { sessionId });
      },
      visibleSessionIds: () => native ? ownedSessionIds(native.getBranch()) : [],
    }, this.records);
  }
}
