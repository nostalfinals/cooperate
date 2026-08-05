import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./coordinator.ts";
import { formatElapsed, snapshotElapsed } from "./presentation.ts";
import { compactPreview } from "./sessions.ts";

interface OverlayOptions {
  theme: Theme;
  snapshots(): readonly SubagentSnapshot[];
  cancel(subagentId: string): Promise<void>;
  close(): void;
  requestRender(): void;
  onDispose?(): void;
  startTimer?: boolean;
}

interface Row {
  snapshot: SubagentSnapshot;
  prefix: string;
}

function isActive(snapshot: SubagentSnapshot): boolean {
  return snapshot.state === "running" || snapshot.state === "waiting";
}

function rowsFor(roots: readonly SubagentSnapshot[]): Row[] {
  const rows: Row[] = [];
  const visit = (snapshot: SubagentSnapshot, prefix: string): void => {
    if (!isActive(snapshot)) return;
    rows.push({ snapshot, prefix });
    const activeChildren = snapshot.children.filter(isActive);
    activeChildren.forEach((child, index) => visit(child, prefix + (index === activeChildren.length - 1 ? "└─ " : "├─ ")));
  };
  roots.forEach((root) => visit(root, ""));
  return rows;
}

function key(data: string, name: "up" | "down" | "left" | "right" | "return" | "escape"): boolean {
  return data === name || matchesKey(data, name);
}

function descendantCount(snapshot: SubagentSnapshot): number {
  return snapshot.children.filter(isActive).reduce((count, child) => count + 1 + descendantCount(child), 0);
}

/** Stateful bordered component backing the `/subagents` overlay. */
export class SubagentsOverlay implements Component {
  private readonly options: OverlayOptions;
  private mode: "list" | "detail" | "confirm" = "list";
  private selected = 0;
  private detailId?: string;
  private confirmYes = false;
  private cancelling = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: OverlayOptions) {
    this.options = options;
    if (options.startTimer) this.timer = setInterval(options.requestRender, 1_000);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.onDispose?.();
  }

  handleInput(data: string): void {
    if (this.cancelling) return;
    const rows = rowsFor(this.options.snapshots());
    if (this.mode === "list") {
      if (key(data, "escape")) {
        this.dispose();
        this.options.close();
      } else if (key(data, "up")) {
        this.selected = Math.max(0, this.selected - 1);
      } else if (key(data, "down")) {
        this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
      } else if (key(data, "return") && rows[this.selected]) {
        this.detailId = rows[this.selected]!.snapshot.subagentId;
        this.mode = "detail";
      }
    } else if (this.mode === "detail") {
      if (key(data, "escape")) this.mode = "list";
      else if (data.toLowerCase() === "c" && this.currentDetail()) {
        this.confirmYes = false;
        this.mode = "confirm";
      }
    } else {
      if (key(data, "escape")) this.mode = "detail";
      else if (key(data, "left") || key(data, "right")) this.confirmYes = !this.confirmYes;
      else if (key(data, "return")) {
        if (!this.confirmYes) this.mode = "detail";
        else {
          const id = this.detailId;
          if (!id) return;
          this.cancelling = true;
          void this.options.cancel(id).then(() => {
            this.cancelling = false;
            this.mode = "list";
            this.detailId = undefined;
            this.selected = 0;
            this.options.requestRender();
          }, () => {
            this.cancelling = false;
            this.mode = "detail";
            this.options.requestRender();
          });
        }
      }
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const content = this.contentLines();
    const title = " subagents ";
    const top = "╭─" + title + "─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1)) + "╮";
    const body = content.map((line) => {
      const clipped = truncateToWidth(line, innerWidth);
      return "│ " + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + " │";
    });
    return [top, ...body, "╰" + "─".repeat(innerWidth + 2) + "╯"].map((line) => truncateToWidth(line, width));
  }

  private contentLines(): string[] {
    if (this.mode === "list") {
      const rows = rowsFor(this.options.snapshots());
      if (rows.length === 0) return ["No active subagents", "", "Esc close"];
      this.selected = Math.min(this.selected, rows.length - 1);
      const maxVisible = 12;
      const start = Math.max(0, Math.min(this.selected - maxVisible + 1, rows.length - maxVisible));
      const visible = rows.slice(start, start + maxVisible);
      return [
        ...(start > 0 ? [this.options.theme.fg("muted", `↑ ${start} more`)] : []),
        ...visible.map(({ snapshot, prefix }, offset) => {
          const index = start + offset;
          const row = `${index === this.selected ? "›" : " "} ${prefix}${snapshot.agent} ${snapshot.subagentId} ${snapshot.state} ${formatElapsed(snapshotElapsed(snapshot))} ${compactPreview(snapshot.task, 70)}`;
          return index === this.selected ? this.options.theme.fg("accent", row) : row;
        }),
        ...(start + maxVisible < rows.length ? [this.options.theme.fg("muted", `↓ ${rows.length - start - maxVisible} more`)] : []),
        "",
        "↑↓ select · enter details · esc close",
      ];
    }
    const snapshot = this.currentDetail();
    if (!snapshot) {
      this.mode = "list";
      return ["No active subagents", "", "Esc close"];
    }
    if (this.mode === "confirm") {
      const descendants = descendantCount(snapshot);
      return [
        `Cancel ${snapshot.agent} and its ${descendants} descendant${descendants === 1 ? "" : "s"}?`,
        "",
        this.cancelling ? "cancelling…" : this.confirmYes ? " No  [Yes]" : "[No]  Yes",
        "",
        "←→ choose · Enter confirm · Esc back",
      ];
    }
    return [
      `${snapshot.agent} · ${snapshot.state} · ${formatElapsed(snapshotElapsed(snapshot))}`,
      `task ${snapshot.task}`,
      `model ${snapshot.model ?? "unknown"}`,
      `thinking ${snapshot.thinking ?? "unknown"}`,
      `depth ${snapshot.depth}`,
      `subagent ${snapshot.subagentId}`,
      `Session ${snapshot.sessionId}`,
      `direct children ${snapshot.children.filter(isActive).length}`,
      "",
      "c cancel subtree   esc back",
    ];
  }

  private currentDetail(): SubagentSnapshot | undefined {
    if (!this.detailId) return undefined;
    return rowsFor(this.options.snapshots()).find((row) => row.snapshot.subagentId === this.detailId)?.snapshot;
  }
}
