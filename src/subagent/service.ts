import { createCallerCatalog } from "../catalog/catalog.ts";
import { DEFAULT_TIMER_REMINDER_SECONDS } from "../catalog/config.ts";
import { includesEntry, isWildcard, resolveEntries, type AgentDefinition, type DefinitionCatalog } from "../catalog/definitions.ts";
import { type CompletionNotice, type Messenger, type ReminderNotice, DeferredMessenger } from "./messenger.ts";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "../session/ownership.ts";
import { compactPreview, truncateForTool } from "../text.ts";
import type { SessionRecord, SessionStore } from "../session/types.ts";
import type { SubagentHistory } from "../session/history.ts";
import { SubagentHistoryView } from "../session/history-view.ts";
import { describeLastMessage, flattenTree, messageContent, summarizeEntries } from "./messages.ts";
import type { ChildRuntimeFactory, SubagentRun } from "../runtime/types.ts";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { SubagentToolFactory } from "../tool/types.ts";
import { StructuredCoordinator } from "./coordinator.ts";
import { extractFinalText } from "./result.ts";
import { isActive } from "./types.ts";
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
  messenger?: Messenger;
  /** Sidecar history of completed top-level runs; only the top-level service writes it. */
  history?: SubagentHistory;
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
  explicitCancel: boolean;
  suppressNotification: boolean;
  notificationSuppressed: Promise<void>;
  resolveNotificationSuppressed(): void;
  done: Promise<void>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_HISTORY_PAGE_SIZE = 50;

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
  private readonly historyView: SubagentHistoryView;
  private messenger?: Messenger;
  private disposed = false;
  private reminderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly remindedPeriods = new Map<string, number>();
  private readonly timerReminderIntervalMs: number;

  constructor(options: SubagentServiceOptions, records = new Map<string, SessionRecord>()) {
    this.options = options;
    this.records = records;
    this.timerReminderIntervalMs = (options.catalog.config.timerReminderSeconds ?? DEFAULT_TIMER_REMINDER_SECONDS) * 1000;
    this.historyView = new SubagentHistoryView(options.history, options.store);
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
    if (!this.messenger) {
      throw new Error("background subagent startup requires a bound messenger");
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
          if (terminal.state !== "failed") await nestedService.waitForDescendantProgress();
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
    const outcomePromise = this.executeRun(subagentId, request.prompt, run, environment.signal)
      .then((outcome) => {
        environment.onSnapshot?.(outcome.snapshot);
        return outcome;
      })
      .then(async (outcome) => {
        await this.recordHistory(record, outcome);
        return outcome;
      })
      .finally(() => {
        this.runs.delete(subagentId);
        unsubscribe?.();
      });
    let resolveNotificationSuppressed!: () => void;
    const notificationSuppressed = new Promise<void>((resolve) => { resolveNotificationSuppressed = resolve; });
    const handle: ActiveExecution = {
      explicitCancel: false,
      suppressNotification: false,
      notificationSuppressed,
      resolveNotificationSuppressed,
      done: Promise.resolve(),
    };
    this.active.set(subagentId, handle);

    const startupCommitted = environment.toolCallId
      ? this.messenger.waitForStartupCommit(environment.toolCallId)
      : Promise.resolve();
    handle.done = this.completeAsync(handle, outcomePromise, startupCommitted)
      .finally(() => {
        this.active.delete(subagentId);
        this.childServices.delete(subagentId);
        this.refreshReminderClock();
      });
    void handle.done;
    this.refreshReminderClock();
    return {
      sessionId: record.sessionId,
      subagentId,
      result: `Started background subagent ${request.agent} (subagentId=${subagentId}, sessionId=${record.sessionId})`,
    };
  }

  listSubagents(all = false): readonly Record<string, unknown>[] {
    const toEntry = (binding: SubagentSnapshot) => ({
      subagentId: binding.subagentId,
      agent: binding.agent,
      session: binding.sessionId,
      task: compactPreview(binding.task),
      state: binding.state,
      elapsedMs: binding.elapsedMs,
    });
    const active = this.coordinator.directChildren(this.parentId).map(toEntry);
    if (!all) return active;
    return [...active, ...this.coordinator.completedDirectChildren(this.parentId).map(toEntry)];
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

  async cancel(subagentId: string): Promise<SubagentSnapshot | undefined> {
    const [handle] = this.captureDirect([subagentId]);
    handle!.explicitCancel = true;
    handle!.resolveNotificationSuppressed();
    this.coordinator.requestCancel(subagentId, "cancelled by user");
    await handle!.done;
    return this.coordinator.snapshotOrLast(subagentId);
  }

  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined {
    return this.coordinator.snapshotOrLast(subagentId);
  }

  /** Current state of a direct child, including its latest output and pending steering. */
  inspectSubagent(subagentId: string): Record<string, unknown> {
    const snapshot = this.requireDirectSnapshot(subagentId);
    const steering = this.getSteeringMessages(subagentId);
    const lastMessage = isActive(snapshot)
      ? describeLastMessage(this.runs.get(subagentId)?.messagesSinceStart() ?? [])
      : undefined;
    const history = this.historyView.record(subagentId);
    return {
      subagentId: snapshot.subagentId,
      sessionId: snapshot.sessionId,
      agent: snapshot.agent,
      task: snapshot.task,
      state: snapshot.state,
      elapsedMs: snapshot.elapsedMs,
      model: snapshot.model,
      thinking: snapshot.thinking,
      activity: snapshot.activity,
      steering,
      ...(lastMessage ? { lastMessage } : {}),
      ...(history?.result !== undefined ? { result: history.result } : {}),
    };
  }

  /**
   * Paginated transcript of a direct child. Messages are summarized with ids;
   * pass messageId to expand one message's full content.
   */
  async historyMessages(
    subagentId: string,
    options: { offset?: number; limit?: number; messageId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const snapshot = this.requireDirectSnapshot(subagentId);
    const entries = await this.historyEntries(subagentId, snapshot);
    if (options.messageId !== undefined) {
      const entry = entries.find((candidate) => candidate.id === options.messageId);
      if (!entry) throw new Error(`Message '${options.messageId}' does not exist in subagent '${subagentId}'`);
      return { subagentId: snapshot.subagentId, sessionId: snapshot.sessionId, message: messageContent(entry) };
    }
    const summaries = summarizeEntries(entries);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_PAGE_SIZE));
    return {
      subagentId: snapshot.subagentId,
      sessionId: snapshot.sessionId,
      total: summaries.length,
      offset,
      limit,
      messages: summaries.slice(offset, offset + limit),
    };
  }

  private async historyEntries(subagentId: string, snapshot: SubagentSnapshot): Promise<readonly SessionEntry[]> {
    if (isActive(snapshot)) {
      const native = this.records.get(subagentId)?.native as { getBranch?(): readonly SessionEntry[] } | undefined;
      return native?.getBranch?.() ?? [];
    }
    const tree = await this.loadHistoryTree(subagentId);
    return tree ? flattenTree(tree) : [];
  }

  private requireDirectSnapshot(subagentId: string): SubagentSnapshot {
    const snapshot = this.coordinator.snapshotOrLast(subagentId);
    if (!snapshot || snapshot.parentId !== this.parentId) {
      throw new Error(`Subagent '${subagentId}' is not a direct child of this agent`);
    }
    return snapshot;
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

  historyRoots(): readonly SubagentSnapshot[] {
    return this.historyView.roots();
  }

  historyRecord(subagentId: string): { snapshot: SubagentSnapshot; result?: string } | undefined {
    return this.historyView.record(subagentId);
  }

  historyTree(subagentId: string): readonly SessionTreeNode[] | undefined {
    return this.historyView.tree(subagentId);
  }

  async loadHistoryTree(subagentId: string): Promise<readonly SessionTreeNode[] | undefined> {
    return this.historyView.loadTree(subagentId);
  }

  releaseHistoryTree(subagentId: string): void {
    this.historyView.releaseTree(subagentId);
  }

  async steer(subagentId: string, text: string): Promise<void> {
    const owner = this.findRunOwner(subagentId);
    const run = owner?.runs.get(subagentId);
    if (!run) throw new Error(`Subagent '${subagentId}' is not active`);
    await run.steer?.(text);
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

  async waitForDescendantProgress(): Promise<void> {
    const active = [...this.active.values()];
    if (active.length > 0) await Promise.race(active.map((handle) => handle.done));
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
    this.stopReminderClock();
    await this.cancelActive("runtime shutting down");
  }

  private dispatchReminder(reminder: ReminderNotice): void {
    // Reminders are best-effort nudges; delivery failures must not break the run.
    void this.messenger?.sendReminder(reminder).catch(() => undefined);
  }

  private activeDirectChildren(): readonly SubagentSnapshot[] {
    return this.coordinator.directChildren(this.parentId).filter(isActive);
  }

  private refreshReminderClock(): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = undefined;
    }
    if (this.activeDirectChildren().length === 0) {
      // Every direct subagent is done: reset the periodic-reminder clock.
      this.remindedPeriods.clear();
      return;
    }
    this.scheduleReminderTick();
  }

  private stopReminderClock(): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = undefined;
    }
    this.remindedPeriods.clear();
  }

  private scheduleReminderTick(): void {
    const active = this.activeDirectChildren();
    if (active.length === 0) {
      this.remindedPeriods.clear();
      return;
    }
    const now = Date.now();
    const nextIn = Math.min(...active.map((snapshot) => {
      const elapsed = Math.max(0, now - snapshot.startedAt);
      const nextBoundary = (Math.floor(elapsed / this.timerReminderIntervalMs) + 1) * this.timerReminderIntervalMs;
      return nextBoundary - elapsed;
    }));
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = undefined;
      void this.fireReminderTick();
    }, Math.max(0, nextIn));
    this.reminderTimer.unref?.();
  }

  private async fireReminderTick(): Promise<void> {
    const due = this.activeDirectChildren().filter((snapshot) => {
      const period = Math.floor(snapshot.elapsedMs / this.timerReminderIntervalMs);
      if (period < 1 || (this.remindedPeriods.get(snapshot.subagentId) ?? 0) >= period) return false;
      this.remindedPeriods.set(snapshot.subagentId, period);
      return true;
    });
    if (due.length > 0) {
      const lines = due.map((snapshot) => `- ${snapshot.agent} (subagentId=${snapshot.subagentId}) running for ${Math.floor(snapshot.elapsedMs / 60000)}m`);
      this.dispatchReminder({
        elapsedMs: Math.max(...due.map((snapshot) => snapshot.elapsedMs)),
        subagentIds: due.map((snapshot) => snapshot.subagentId),
        text: `Some time has passed and these subagents are still running:\n${lines.join("\n")}\nConsider inspecting their status and reporting progress to the user.`,
      });
    }
    this.refreshReminderClock();
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

  private async recordHistory(record: SessionRecord, outcome: ExecutionOutcome): Promise<void> {
    const history = this.options.history;
    if (!history) return;
    try {
      const native = record.native as { getEntries?(): readonly unknown[] } | undefined;
      const endCount = native?.getEntries?.().length ?? 0;
      if (this.parentId === undefined) {
        await history.append({
          subagentId: outcome.snapshot.subagentId,
          sessionId: outcome.snapshot.sessionId,
          snapshot: outcome.snapshot,
          result: outcome.result,
          endCount,
          completedAt: Date.now(),
        });
      } else {
        // Nested runs record only their completion boundary so a session file
        // shared by later subagents can still be truncated per subagent.
        await history.appendBoundary({
          subagentId: outcome.snapshot.subagentId,
          sessionId: outcome.snapshot.sessionId,
          endCount,
          completedAt: Date.now(),
        });
      }
    } catch {
      // History is best-effort metadata; a failed append must not fail the run.
    }
  }

  private async executeRun(
    subagentId: string,
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
