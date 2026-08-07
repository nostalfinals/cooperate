import { Container, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { isActive, type SubagentSnapshot } from "../../subagent/types.ts";
import { formatElapsed, snapshotElapsed, stateMark } from "../presentation.ts";
import { collectToolCalls, flattenTree, viewport, type HistoryRow } from "./session-lines.ts";
import { shell, selectable } from "./shell.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

/** Per-subagent detail: header, message history, steering summary, actions. */
export class DetailView implements PanelView {
  private readonly ctx: PanelContext;

  constructor(ctx: PanelContext) {
    this.ctx = ctx;
  }

  stale(): boolean {
    return !this.ctx.detailSnapshot();
  }

  handleInput(data: string): void {
    const snapshot = this.ctx.detailSnapshot();
    if (!snapshot) return;
    const rows = this.historyRows(snapshot);
    if (key(data, "escape")) {
      this.ctx.showList();
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      if (rows.length > 0) {
        const current = rows.findIndex((row) => row.id === this.ctx.selectedEntryId());
        const step = key(data, "down") ? 1 : -1;
        // Wrap around: up from the first entry goes to the last, down from the
        // last entry goes back to the first.
        let index: number;
        if (current === -1) {
          index = 0;
        } else if (current === 0 && step === -1) {
          index = rows.length - 1;
        } else if (current === rows.length - 1 && step === 1) {
          index = 0;
        } else {
          index = current + step;
        }
        this.ctx.selectEntry(rows[index]!.id);
      }
      return;
    }
    if (key(data, "enter") && this.ctx.selectedEntryId()) {
      this.ctx.showMessage();
      return;
    }
    if (data.toLowerCase() === "c" && isActive(snapshot)) {
      this.ctx.showConfirm();
      return;
    }
    if ((data.toLowerCase() === "s" || matchesKey(data, "alt+up")) && isActive(snapshot)) {
      this.ctx.showSteer();
    }
  }

  render(width: number): Container {
    const theme = this.ctx.theme;
    const snapshot = this.ctx.detailSnapshot()!;
    const header = stateMark(snapshot.state, theme, snapshotElapsed(snapshot)) + " " + theme.fg("accent", snapshot.agent) + " "
      + theme.fg("muted", `${formatElapsed(snapshotElapsed(snapshot))} · ${snapshot.subagentId.slice(0, 7)} · ${snapshot.sessionId}`);
    const rows = this.historyRows(snapshot);
    const lines = [header, "", theme.fg("muted", snapshot.task), ""];
    if (rows.length === 0) {
      // Historical sessions are loaded lazily; until the tree is ready (or if the
      // session file is gone) fall back to the stored final result text.
      const fallback = this.ctx.historyDetail?.(snapshot.subagentId)?.result;
      lines.push(fallback ? theme.fg("muted", fallback) : theme.fg("muted", "No messages yet"));
    } else {
      const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === this.ctx.selectedEntryId()));
      this.ctx.selectEntry(rows[selectedIndex]!.id);
      const visible = viewport(rows, selectedIndex, this.ctx.maxVisible);
      const maxWidth = Math.max(20, width - 6);
      lines.push(...visible.map((row) =>
        selectable(truncateToWidth(row.line, maxWidth, "…"), row.id === this.ctx.selectedEntryId(), theme)));
    }
    if (isActive(snapshot)) {
      const steering = this.ctx.getSteeringMessages(snapshot.subagentId);
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
    return shell(theme, undefined, lines, footer);
  }

  private historyRows(snapshot: SubagentSnapshot): HistoryRow[] {
    const roots = this.ctx.getTree(snapshot.subagentId) ?? [];
    const toolCalls = collectToolCalls(roots);
    return flattenTree(roots, this.ctx.theme, toolCalls);
  }
}
