import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import { collectTreeRows, type TreeRow } from "../tree.ts";
import { renderActivityTitle } from "../../tool/activity-title.ts";
import { viewport } from "./session-lines.ts";
import { shell, selectable } from "./shell.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

/** The subagent tree overview: the panel's default mode. */
export class ListView implements PanelView {
  private readonly ctx: PanelContext;

  constructor(ctx: PanelContext) {
    this.ctx = ctx;
  }

  handleInput(data: string): void {
    const rows = this.listRows();
    if (key(data, "escape")) {
      this.ctx.close();
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      const current = Math.max(0, rows.findIndex((row) => row.id === this.ctx.selectedId()));
      const step = key(data, "down") ? 1 : -1;
      let index = current + step;
      while (rows[index] !== undefined && rows[index]!.id === "") index += step;
      if (rows[index] === undefined) {
        // Wrapped past the edge: continue from the other end, so up from the
        // top entry lands on the last selectable row (and vice versa).
        index = step > 0 ? 0 : rows.length - 1;
        while (rows[index] !== undefined && rows[index]!.id === "") index += step;
      }
      if (rows[index] !== undefined) this.ctx.selectId(rows[index]!.id);
      return;
    }
    if (key(data, "enter") && this.ctx.selectedId()) {
      this.ctx.showDetail(this.ctx.selectedId()!);
    }
  }

  render(width: number): Container {
    const theme = this.ctx.theme;
    const rows = this.listRows();
    if (rows.length === 0) {
      return shell(theme, "Subagents", ["No active subagents"], "esc close");
    }
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === this.ctx.selectedId()));
    this.ctx.selectId(rows[selectedIndex]!.id);
    const visible = viewport(rows, selectedIndex, this.ctx.maxVisible);
    const maxWidth = Math.max(20, width - 4);
    const lines = visible.map((row) =>
      selectable(truncateToWidth(row.line, maxWidth, "…"), row.id === this.ctx.selectedId(), theme));
    return shell(theme, "Subagents", lines, "esc close · enter inspect");
  }

  private listRows(): TreeRow[] {
    const rows: TreeRow[] = [];
    for (const root of this.ctx.snapshots()) {
      rows.push(...collectTreeRows(root, this.ctx.theme, true, renderActivityTitle));
    }
    return rows;
  }
}
