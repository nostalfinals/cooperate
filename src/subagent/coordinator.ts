import { randomBytes } from "node:crypto";
import type {
  StartNode,
  StartedNode,
  SubagentActivity,
  SubagentSnapshot,
  TerminalCause,
  TerminalSubagentState,
} from "./types.ts";

interface CoordinatorOptions {
  generateId?: () => string;
  now?: () => number;
}

interface NodeRecord {
  subagentId: string;
  parentId?: string;
  agent: string;
  sessionId: string;
  task: string;
  model?: string;
  thinking?: string;
  depth: number;
  startedAt: number;
  children: Set<string>;
  completedChildren: SubagentSnapshot[];
  activity?: SubagentActivity;
  ownCause?: TerminalCause;
  abort?: () => void;
  abortInvoked: boolean;
  scopeSettled: Promise<void>;
  resolveScope(): void;
}

function freezeSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  for (const child of snapshot.children) freezeSnapshot(child);
  Object.freeze(snapshot.children);
  return Object.freeze(snapshot);
}

/** In-memory ownership and cancellation coordinator for one master runtime tree. */
export class StructuredCoordinator {
  private readonly maxDepth: number;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly locks = new Map<string, string>();
  private readonly rootChildren = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly completed = new Map<string, SubagentSnapshot>();

  constructor(maxDepth: number, options: CoordinatorOptions = {}) {
    this.maxDepth = maxDepth;
    this.generateId = options.generateId ?? (() => randomBytes(4).toString("hex"));
    this.now = options.now ?? Date.now;
  }

  assertCanStart(parentId?: string): number {
    const parent = parentId === undefined ? undefined : this.nodes.get(parentId);
    if (parentId !== undefined && !parent) throw new Error(`Parent subagent '${parentId}' is not active`);
    const depth = parent ? parent.depth + 1 : 2;
    if (depth > this.maxDepth) throw new Error(`subagent run would exceed maxDepth ${this.maxDepth}`);
    return depth;
  }

  start(input: StartNode): StartedNode {
    const depth = this.assertCanStart(input.parentId);
    const parent = input.parentId === undefined ? undefined : this.nodes.get(input.parentId);
    if (this.locks.has(input.sessionId)) throw new Error(`Session '${input.sessionId}' is locked`);

    let subagentId: string;
    do subagentId = this.generateId(); while (this.nodes.has(subagentId));
    if (!/^[0-9a-f]{8}$/.test(subagentId)) throw new Error("generated subagent ID must be exactly eight lowercase hexadecimal characters");

    let resolveScope!: () => void;
    const node: NodeRecord = {
      ...input,
      subagentId,
      depth,
      startedAt: this.now(),
      children: new Set(),
      completedChildren: [],
      abortInvoked: false,
      scopeSettled: new Promise<void>((resolve) => { resolveScope = resolve; }),
      resolveScope: () => resolveScope(),
    };
    this.nodes.set(subagentId, node);
    this.locks.set(input.sessionId, subagentId);
    if (parent) parent.children.add(subagentId);
    else this.rootChildren.add(subagentId);
    this.emit();
    return { subagentId, depth };
  }

  attachAbort(subagentId: string, abort: () => void): void {
    const node = this.require(subagentId);
    node.abort = abort;
    if (node.abortInvoked) abort();
  }

  setRuntimeInfo(subagentId: string, info: { model: string; thinking: string }): void {
    const node = this.require(subagentId);
    node.model = info.model;
    node.thinking = info.thinking;
    this.emit();
  }

  setActivity(subagentId: string, activity: SubagentActivity): void {
    const node = this.nodes.get(subagentId);
    if (!node) return;
    node.activity = activity;
    this.emit();
  }

  ownLoopEnded(subagentId: string, cause: TerminalCause): void {
    const node = this.nodes.get(subagentId);
    if (!node || node.ownCause) return;
    node.ownCause = { ...cause };
    if (cause.state === "failed" || cause.state === "cancelled") {
      for (const childId of [...node.children]) this.requestCancel(childId, cause.reason ?? cause.state);
    }
    this.emit();
  }

  async finish(subagentId: string, cause: TerminalCause): Promise<SubagentSnapshot | undefined> {
    const node = this.nodes.get(subagentId);
    if (!node) return undefined;
    this.ownLoopEnded(subagentId, cause);
    await this.waitForDescendants(subagentId);
    // A racing disposer may already have won while this call was awaiting.
    const current = this.nodes.get(subagentId);
    if (!current) return undefined;

    const terminal = current.ownCause ?? cause;
    const snapshot = this.makeSnapshot(current, terminal.state, terminal.reason);
    this.completed.set(subagentId, snapshot);
    this.nodes.delete(subagentId);
    this.locks.delete(current.sessionId);
    const parent = current.parentId ? this.nodes.get(current.parentId) : undefined;
    if (parent) {
      parent.children.delete(subagentId);
      parent.completedChildren.push(snapshot);
    } else {
      this.rootChildren.delete(subagentId);
    }
    current.resolveScope();
    this.emit();
    return snapshot;
  }

  requestCancel(subagentId: string, reason = "cancelled"): void {
    const node = this.nodes.get(subagentId);
    if (!node) return;
    if (!node.ownCause) node.ownCause = { state: "cancelled", reason };
    if (!node.abortInvoked) {
      node.abortInvoked = true;
      node.abort?.();
    }
    for (const childId of [...node.children]) this.requestCancel(childId, reason);
    this.emit();
  }

  async cancelAndWait(subagentId: string, reason = "cancelled"): Promise<void> {
    const node = this.nodes.get(subagentId);
    if (!node) return;
    this.requestCancel(subagentId, reason);
    await node.scopeSettled;
  }

  async cancelAll(reason = "cancelled"): Promise<void> {
    const roots = [...this.rootChildren].map((id) => this.nodes.get(id)).filter((node): node is NodeRecord => node !== undefined);
    for (const node of roots) this.requestCancel(node.subagentId, reason);
    await Promise.all(roots.map((node) => node.scopeSettled));
  }

  waitForDescendants(parentId?: string): Promise<void> {
    const childIds = parentId === undefined ? this.rootChildren : this.require(parentId).children;
    const children = [...childIds].map((id) => this.nodes.get(id)).filter((node): node is NodeRecord => node !== undefined);
    return Promise.all(children.map((child) => child.scopeSettled)).then(() => undefined);
  }

  get(subagentId: string): SubagentSnapshot | undefined {
    const node = this.nodes.get(subagentId);
    return node ? this.makeSnapshot(node) : undefined;
  }

  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined {
    return this.get(subagentId) ?? this.completed.get(subagentId);
  }

  snapshot(subagentId: string): SubagentSnapshot | undefined {
    return this.get(subagentId);
  }

  snapshotRoots(): readonly SubagentSnapshot[] {
    return Object.freeze([...this.rootChildren]
      .map((id) => this.nodes.get(id))
      .filter((node): node is NodeRecord => node !== undefined)
      .map((node) => this.makeSnapshot(node)));
  }

  directChildren(parentId?: string): readonly SubagentSnapshot[] {
    const ids = parentId === undefined ? this.rootChildren : this.require(parentId).children;
    return Object.freeze([...ids]
      .map((id) => this.nodes.get(id))
      .filter((node): node is NodeRecord => node !== undefined)
      .map((node) => this.makeSnapshot(node)));
  }

  isSessionLocked(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(subagentId: string): NodeRecord {
    const node = this.nodes.get(subagentId);
    if (!node) throw new Error(`Subagent '${subagentId}' is not active`);
    return node;
  }

  private makeSnapshot(node: NodeRecord, forcedState?: TerminalSubagentState, reason?: string): SubagentSnapshot {
    const activeChildren = [...node.children]
      .map((id) => this.nodes.get(id))
      .filter((child): child is NodeRecord => child !== undefined)
      .map((child) => this.makeSnapshot(child));
    const children = [...node.completedChildren, ...activeChildren]
      .sort((left, right) => left.startedAt - right.startedAt);
    const state = forcedState ?? (node.ownCause && activeChildren.length > 0 ? "waiting" : "running");
    return freezeSnapshot({
      subagentId: node.subagentId,
      parentId: node.parentId,
      agent: node.agent,
      sessionId: node.sessionId,
      task: node.task,
      model: node.model,
      thinking: node.thinking,
      depth: node.depth,
      startedAt: node.startedAt,
      elapsedMs: Math.max(0, this.now() - node.startedAt),
      state,
      reason: reason ?? (forcedState ? node.ownCause?.reason : undefined),
      activity: node.activity,
      children,
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
