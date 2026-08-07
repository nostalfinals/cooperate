import type { Container } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { SessionTreeNode, Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../../subagent/types.ts";

export interface PanelOptions {
  theme: Theme;
  snapshots(): readonly SubagentSnapshot[];
  snapshotOf(subagentId: string): SubagentSnapshot | undefined;
  cancel(subagentId: string): Promise<void>;
  steer(subagentId: string, text: string): Promise<void>;
  replaceSteering(subagentId: string, text: string): Promise<void>;
  getSteeringMessages(subagentId: string): readonly string[];
  getTree(subagentId: string): readonly SessionTreeNode[] | undefined;
  /** Completed top-level runs of this master session, oldest first. */
  historyRoots(): readonly SubagentSnapshot[];
  /** Snapshot (+ final result text) of a completed run, including nested subagents. */
  historyDetail(subagentId: string): { snapshot: SubagentSnapshot; result?: string } | undefined;
  /** Load and cache the truncated tree of a historical subagent session. */
  loadHistoryTree(subagentId: string): Promise<readonly SessionTreeNode[] | undefined>;
  /** Synchronous cache read for a historical subagent session. */
  getHistoryTree(subagentId: string): readonly SessionTreeNode[] | undefined;
  /** Drop a cached history tree once the panel leaves the detail view. */
  releaseHistoryTree(subagentId: string): void;
  close(): void;
  requestRender(): void;
  onDispose?(): void;
  startTimer?: boolean;
  terminalRows: number;
}

export interface PanelContext {
  theme: Theme;
  maxVisible: number;
  snapshots(): readonly SubagentSnapshot[];
  detailSnapshot(): SubagentSnapshot | undefined;
  getTree(subagentId: string): readonly SessionTreeNode[] | undefined;
  getSteeringMessages(subagentId: string): readonly string[];
  cancel(subagentId: string): Promise<void>;
  replaceSteering(subagentId: string, text: string): Promise<void>;
  requestRender(): void;
  close(): void;
  /** Currently selected list row (survives view switches). */
  selectedId(): string | undefined;
  selectId(id: string): void;
  /** Currently selected history entry in the detail/message views. */
  selectedEntryId(): string | undefined;
  selectEntry(id: string): void;
  /** Which list is shown: currently active runs or completed history runs. */
  tab(): "active" | "history";
  switchTab(): void;
  historyRoots(): readonly SubagentSnapshot[];
  historyDetail(subagentId: string): { snapshot: SubagentSnapshot; result?: string } | undefined;
  getHistoryTree(subagentId: string): readonly SessionTreeNode[] | undefined;
  showList(): void;
  showDetail(id: string): void;
  /** Return to detail from message/confirm/steer, keeping the selected entry. */
  backToDetail(): void;
  showMessage(): void;
  showConfirm(): void;
  showSteer(): void;
  /** Whether the given view is the active one (for deferred callbacks). */
  isCurrent(view: PanelView): boolean;
}

export interface PanelView {
  handleInput(data: string): void;
  render(width: number): Container;
  dispose?(): void;
  /** True when the view's data vanished and the shell should fall back to list. */
  stale?(): boolean;
}

export function key(data: string, name: "up" | "down" | "enter" | "escape" | "left" | "right"): boolean {
  return matchesKey(data, name);
}
