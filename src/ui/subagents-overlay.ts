import { Container, Input, Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { copyToClipboard, DynamicBorder, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../subagent/types.ts";
import { formatElapsed, snapshotElapsed, stateMark, collectTreeRows, type TreeRow } from "./presentation.ts";
import { renderActivityTitle } from "../tool/renderer.ts";

interface OverlayOptions {
  theme: Theme;
  snapshots(): readonly SubagentSnapshot[];
  snapshotOf(subagentId: string): SubagentSnapshot | undefined;
  cancel(subagentId: string): Promise<void>;
  steer(subagentId: string, text: string): Promise<void>;
  replaceSteering(subagentId: string, text: string): Promise<void>;
  getSteeringMessages(subagentId: string): readonly string[];
  getTree(subagentId: string): readonly SessionTreeNode[] | undefined;
  close(): void;
  requestRender(): void;
  onDispose?(): void;
  startTimer?: boolean;
  terminalRows: number;
}

type Mode = "list" | "detail" | "message" | "confirm" | "steer";

function isActive(snapshot: SubagentSnapshot): boolean {
  return snapshot.state === "running" || snapshot.state === "waiting";
}

function key(data: string, name: "up" | "down" | "enter" | "escape"): boolean {
  return matchesKey(data, name);
}

function normalize(text: string): string {
  return text.replace(/[\n\t]/g, " ").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text?: string } =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

function collectToolCalls(roots: readonly SessionTreeNode[]): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  const visit = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      const entry = node.entry;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
              map.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> });
            }
          }
        }
      }
      visit(node.children);
    }
  };
  visit(roots);
  return map;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  const path = (): string => String(args.path ?? args.file_path ?? "");
  switch (name) {
    case "read": return `[read: ${path()}]`;
    case "write": return `[write: ${path()}]`;
    case "edit": return `[edit: ${path()}]`;
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string");
      return `[${name}${first !== undefined ? `: ${first}` : ""}]`;
    }
  }
}

function entryDisplayText(entry: SessionTreeNode["entry"], theme: Theme, toolCalls: Map<string, ToolCallInfo>): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "user") {
        return theme.fg("accent", "user: ") + normalize(extractText(message.content));
      }
      if (message.role === "assistant") {
        const label = theme.fg("success", "assistant: ");
        const text = normalize(extractText(message.content));
        if (text) return label + text;
        if (message.stopReason === "aborted") return label + theme.fg("muted", "(aborted)");
        if (message.errorMessage) return label + theme.fg("error", normalize(message.errorMessage));
        return label + theme.fg("muted", "(no content)");
      }
      if (message.role === "toolResult") {
        const call = toolCalls.get(message.toolCallId);
        return theme.fg("muted", call ? formatToolCall(call.name, call.args) : `[${message.toolName}]`);
      }
      if (message.role === "bashExecution") {
        return theme.fg("dim", `[bash]: ${normalize(message.command ?? "")}`);
      }
      return theme.fg("dim", `[${message.role}]`);
    }
    case "compaction":
      return theme.fg("borderAccent", `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`);
    case "custom_message":
      return theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(extractText(entry.content));
    case "model_change":
      return theme.fg("dim", `[model: ${entry.modelId}]`);
    case "thinking_level_change":
      return theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
    default:
      return theme.fg("dim", `[${entry.type}]`);
  }
}

interface HistoryRow {
  id: string;
  line: string;
}

function flattenTree(roots: readonly SessionTreeNode[], theme: Theme, toolCalls: Map<string, ToolCallInfo>): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const visit = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      rows.push({ id: node.entry.id, line: entryDisplayText(node.entry, theme, toolCalls) });
      visit(node.children);
    }
  };
  visit(roots);
  return rows;
}

function fullMessageText(entry: SessionTreeNode["entry"]): string {
  if (entry.type !== "message") return "";
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): boolean =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

function viewport<T>(rows: readonly T[], selectedIndex: number, maxVisible: number): T[] {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible));
  return rows.slice(start, start + maxVisible);
}

/** Model-preset-style component backing the `/subagents` command. */
export class SubagentsOverlay implements Component {
  private readonly options: OverlayOptions;
  private readonly maxVisible: number;
  private mode: Mode = "list";
  private selectedId?: string;
  private detailId?: string;
  private selectedEntryId?: string;
  private confirmChoice: "no" | "yes" = "no";
  private steerInput?: Input;
  private cancelling = false;
  private copied = false;
  private copyTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: OverlayOptions) {
    this.options = options;
    this.maxVisible = Math.max(5, Math.floor(options.terminalRows / 2));
    if (options.startTimer) this.timer = setInterval(options.requestRender, 1_000);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = undefined;
    this.options.onDispose?.();
  }

  handleInput(data: string): void {
    if (this.cancelling) return;
    switch (this.mode) {
      case "list":
        this.handleListInput(data);
        break;
      case "detail":
        this.handleDetailInput(data);
        break;
      case "message":
        this.handleMessageInput(data);
        break;
      case "confirm":
        this.handleConfirmInput(data);
        break;
      case "steer":
        this.handleSteerInput(data);
        break;
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    if (this.mode === "detail" && !this.currentDetail()) this.showList();
    const container = this.mode === "list"
      ? this.listContainer(width)
      : this.mode === "detail"
        ? this.detailContainer(width)
        : this.mode === "message"
          ? this.messageContainer(width)
          : this.mode === "confirm"
            ? this.confirmContainer(width)
            : this.steerContainer(width);
    return container.render(width);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  private handleListInput(data: string): void {
    const rows = this.listRows();
    if (key(data, "escape")) {
      this.dispose();
      this.options.close();
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      const current = Math.max(0, rows.findIndex((row) => row.id === this.selectedId));
      const step = key(data, "down") ? 1 : -1;
      let index = current + step;
      while (index >= 0 && index < rows.length && rows[index]!.id === "") index += step;
      if (index >= 0 && index < rows.length) this.selectedId = rows[index]!.id;
      return;
    }
    if (key(data, "enter") && this.selectedId) {
      this.detailId = this.selectedId;
      this.selectedEntryId = undefined;
      this.mode = "detail";
    }
  }

  private handleDetailInput(data: string): void {
    const snapshot = this.currentDetail();
    if (!snapshot) return;
    const rows = this.historyRows(snapshot);
    if (key(data, "escape")) {
      this.showList();
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      const current = Math.max(0, rows.findIndex((row) => row.id === this.selectedEntryId));
      const step = key(data, "down") ? 1 : -1;
      if (rows.length > 0) {
        const index = Math.min(rows.length - 1, Math.max(0, current + step));
        this.selectedEntryId = rows[index]!.id;
      }
      return;
    }
    if (key(data, "enter") && this.selectedEntryId) {
      this.mode = "message";
      return;
    }
    if (data.toLowerCase() === "c" && isActive(snapshot)) {
      this.confirmChoice = "no";
      this.mode = "confirm";
      return;
    }
    if (data.toLowerCase() === "s" && isActive(snapshot)) {
      this.openSteerEditor(snapshot.subagentId);
      return;
    }
    if (matchesKey(data, "alt+up") && isActive(snapshot)) {
      this.openSteerEditor(snapshot.subagentId);
    }
  }

  private handleMessageInput(data: string): void {
    if (key(data, "escape")) {
      this.mode = "detail";
      return;
    }
    if (data.toLowerCase() === "c") {
      void this.copySelectedMessage();
    }
  }

  private handleConfirmInput(data: string): void {
    if (key(data, "escape")) {
      this.mode = "detail";
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      this.confirmChoice = this.confirmChoice === "no" ? "yes" : "no";
      return;
    }
    if (key(data, "enter")) {
      this.chooseConfirm(this.confirmChoice);
    }
  }

  private handleSteerInput(data: string): void {
    if (key(data, "escape")) {
      this.closeSteer();
      return;
    }
    this.steerInput?.handleInput(data);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  private chooseConfirm(choice: "no" | "yes"): void {
    const snapshot = this.currentDetail();
    if (!snapshot || !isActive(snapshot)) {
      // Subagent finished while the confirmation was open: both choices no-op.
      this.mode = "detail";
      return;
    }
    if (choice === "no") {
      this.mode = "detail";
      return;
    }
    this.cancelling = true;
    this.options.requestRender();
    void this.options.cancel(snapshot.subagentId).then(() => {
      this.cancelling = false;
      this.showList();
    }, () => {
      this.cancelling = false;
      this.mode = "detail";
    });
  }

  private openSteerEditor(subagentId: string): void {
    const input = new Input();
    const steering = this.options.getSteeringMessages(subagentId);
    if (steering.length > 0) input.setValue(steering.join("\n"));
    input.onSubmit = (text) => this.submitSteer(text);
    input.onEscape = () => this.closeSteer();
    this.steerInput = input;
    this.mode = "steer";
  }

  private closeSteer(): void {
    this.steerInput = undefined;
    this.mode = "detail";
  }

  private submitSteer(text: string): void {
    const snapshot = this.currentDetail();
    this.closeSteer();
    if (!snapshot || !isActive(snapshot) || text.trim().length === 0) return;
    void this.options.replaceSteering(snapshot.subagentId, text.trim());
  }

  private async copySelectedMessage(): Promise<void> {
    const snapshot = this.currentDetail();
    if (!snapshot) return;
    const entry = this.currentMessageEntry(snapshot);
    if (!entry) return;
    try {
      await copyToClipboard(fullMessageText(entry));
      this.copied = true;
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        this.options.requestRender();
      }, 1_500);
    } catch {
      this.copied = false;
    }
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------
  private listRows(): TreeRow[] {
    const rows: TreeRow[] = [];
    for (const root of this.options.snapshots()) {
      rows.push(...collectTreeRows(root, this.options.theme, true, renderActivityTitle));
    }
    return rows;
  }

  private historyRows(snapshot: SubagentSnapshot): HistoryRow[] {
    const roots = this.options.getTree(snapshot.subagentId) ?? [];
    const toolCalls = collectToolCalls(roots);
    return flattenTree(roots, this.options.theme, toolCalls);
  }

  private currentDetail(): SubagentSnapshot | undefined {
    if (!this.detailId) return undefined;
    return this.options.snapshotOf(this.detailId);
  }

  private currentMessageEntry(snapshot: SubagentSnapshot): SessionTreeNode["entry"] | undefined {
    if (!this.selectedEntryId) return undefined;
    const roots = this.options.getTree(snapshot.subagentId) ?? [];
    let found: SessionTreeNode["entry"] | undefined;
    const visit = (nodes: readonly SessionTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.entry.id === this.selectedEntryId) {
          found = node.entry;
          return true;
        }
        if (visit(node.children)) return true;
      }
      return false;
    };
    visit(roots);
    return found;
  }

  private showList(): void {
    this.mode = "list";
    this.detailId = undefined;
    this.selectedEntryId = undefined;
    this.steerInput = undefined;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  private shell(title: string | undefined, bodyLines: string[], footer: string): Container {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => this.options.theme.fg("accent", text)));
    const parts: string[] = [];
    if (title !== undefined) parts.push("", this.options.theme.fg("accent", this.options.theme.bold(title)));
    parts.push("", ...bodyLines, "", this.options.theme.fg("dim", footer), "");
    container.addChild(new Text(parts.join("\n"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => this.options.theme.fg("accent", text)));
    return container;
  }

  private selectable(line: string, selected: boolean, cursor = "›", prefix = 2): string {
    if (!selected) return " ".repeat(prefix) + line;
    const theme = this.options.theme;
    return theme.bg("selectedBg", theme.fg("accent", cursor + " "))
      + theme.bg("selectedBg", theme.bold(line));
  }

  private confirmOption(line: string, selected: boolean): string {
    const theme = this.options.theme;
    if (!selected) return "  " + line;
    return theme.fg("accent", "→ ") + theme.fg("accent", line);
  }

  private listContainer(width: number): Container {
    const theme = this.options.theme;
    const rows = this.listRows();
    if (rows.length === 0) {
      return this.shell("Subagents", ["No active subagents"], "esc close");
    }
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === this.selectedId));
    this.selectedId = rows[selectedIndex]!.id;
    const visible = viewport(rows, selectedIndex, this.maxVisible);
    const maxWidth = Math.max(20, width - 4);
    const lines = visible.map((row) =>
      this.selectable(truncateToWidth(row.line, maxWidth, "…"), row.id === this.selectedId));
    return this.shell("Subagents", lines, "esc close · enter inspect");
  }

  private detailContainer(width: number): Container {
    const theme = this.options.theme;
    const snapshot = this.currentDetail()!;
    const header = stateMark(snapshot, theme) + " " + theme.fg("accent", snapshot.agent) + " "
      + theme.fg("muted", `${formatElapsed(snapshotElapsed(snapshot))} · ${snapshot.subagentId.slice(0, 7)} · ${snapshot.sessionId}`);
    const rows = this.historyRows(snapshot);
    const lines = [header, "", theme.fg("muted", snapshot.task), ""];
    if (rows.length === 0) {
      lines.push(theme.fg("muted", "No messages yet"));
    } else {
      const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === this.selectedEntryId));
      this.selectedEntryId = rows[selectedIndex]!.id;
      const visible = viewport(rows, selectedIndex, this.maxVisible);
      const maxWidth = Math.max(20, width - 6);
      lines.push(...visible.map((row) =>
        this.selectable(truncateToWidth(row.line, maxWidth, "…"), row.id === this.selectedEntryId)));
    }
    if (isActive(snapshot)) {
      const steering = this.options.getSteeringMessages(snapshot.subagentId);
      if (steering.length > 0) {
        lines.push("");
        for (const message of steering) {
          lines.push(theme.fg("dim", `Steering: ${message}`));
        }
      }
    }
    const footer = isActive(snapshot)
      ? "esc back · c cancel · s steer · enter view message"
      : "esc back · enter view message";
    return this.shell(undefined, lines, footer);
  }

  private messageContainer(width: number): Container {
    const snapshot = this.currentDetail();
    const entry = snapshot ? this.currentMessageEntry(snapshot) : undefined;
    if (!entry) return this.shell("Message", ["No message"], "esc back");
    const content = fullMessageText(entry);
    const footer = this.copied ? "esc back · c copy · copied" : "esc back · c copy";
    return this.shell("Message", content.length > 0 ? [content] : [this.options.theme.fg("muted", "(no text content)")], footer);
  }

  private confirmContainer(width: number): Container {
    const snapshot = this.currentDetail();
    const lines: string[] = [];
    if (this.cancelling) {
      lines.push(this.options.theme.fg("muted", "cancelling…"));
    } else if (snapshot) {
      lines.push(`Do you really want to cancel subagent ${snapshot.agent}?`, "");
      lines.push(this.confirmOption("No", this.confirmChoice === "no"));
      lines.push(this.confirmOption("Yes", this.confirmChoice === "yes"));
    }
    return this.shell("Confirm Cancellation", lines, "enter select");
  }

  private steerContainer(width: number): Container {
    const snapshot = this.currentDetail();
    const theme = this.options.theme;
    const lines: string[] = [theme.fg("muted", "Steering instruction:")];
    if (this.steerInput) {
      lines.push(...this.steerInput.render(width - 2).map((line) => line.replace(/\s+$/u, "")));
    }
    return this.shell(snapshot ? `Steer ${snapshot.agent}` : "Steer", lines, "enter send · esc back");
  }
}
