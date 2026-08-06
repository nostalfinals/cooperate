import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { isActive, type SubagentActivity, type SubagentSnapshot } from "../subagent/types.ts";
import { compactPreview } from "../text.ts";
import { formatElapsed, snapshotElapsed, stateMark } from "./presentation.ts";

export type ActivityTitleRenderer = (
  subagentId: string,
  activity: SubagentActivity,
  theme: Theme,
) => string | undefined;

function nodeBody(snapshot: SubagentSnapshot, theme: Theme): string {
  const mark = stateMark(snapshot, theme);
  return mark + " " + theme.fg("accent", snapshot.agent) + " "
    + theme.fg("muted", `${formatElapsed(snapshotElapsed(snapshot))} · ${compactPreview(snapshot.task, 80)}`);
}

function nodeLine(snapshot: SubagentSnapshot, theme: Theme, branchCol: number, isLast: boolean): string {
  if (branchCol < 0) return nodeBody(snapshot, theme);
  return " ".repeat(branchCol) + theme.fg("muted", isLast ? "└─" : "├─") + " " + nodeBody(snapshot, theme);
}

function activityLine(
  snapshot: SubagentSnapshot,
  theme: Theme,
  branchCol: number,
  isLast: boolean,
  activityTitle: ActivityTitleRenderer | undefined,
): string {
  const markCol = branchCol < 0 ? 0 : branchCol + 3;
  const cont = branchCol < 0 || isLast
    ? " ".repeat(markCol)
    : " ".repeat(branchCol) + theme.fg("muted", "│") + " ".repeat(markCol - branchCol - 1);
  if (snapshot.activity) {
    const title = activityTitle?.(snapshot.subagentId, snapshot.activity, theme);
    if (title) return cont + theme.fg("accent", "→") + " " + title;
    return cont + theme.fg("accent", "→") + " " + fallbackActivity(snapshot.activity, theme);
  }
  return cont + theme.fg("accent", "→") + " " + theme.fg("muted", "thinking...");
}

export function fallbackActivity(activity: SubagentActivity, theme: Theme): string {
  const firstString = Object.values(activity.input).find((value): value is string => typeof value === "string");
  const summary = firstString !== undefined
    ? firstString
    : JSON.stringify(activity.input);
  return theme.fg("toolTitle", activity.toolName) + " " + theme.fg("muted", compactPreview(summary, 48));
}

export interface TreeRow {
  /** subagentId for selectable node rows, "" for activity rows. */
  id: string;
  line: string;
}

function collectTreeRows(
  snapshot: SubagentSnapshot,
  theme: Theme,
  expanded: boolean,
  activityTitle: ActivityTitleRenderer | undefined,
  branchCol = -1,
  parentBranchCol = -1,
  isLast = true,
): TreeRow[] {
  const isRoot = branchCol < 0;
  const rows: TreeRow[] = [];
  if (isRoot) {
    rows.push({ id: snapshot.subagentId, line: nodeLine(snapshot, theme, -1, true) });
  } else if (parentBranchCol >= 0) {
    rows.push({
      id: snapshot.subagentId,
      line: " ".repeat(parentBranchCol) + theme.fg("muted", "│") + " ".repeat(branchCol - parentBranchCol - 1)
        + theme.fg("muted", isLast ? "└─" : "├─") + " " + nodeBody(snapshot, theme),
    });
  } else {
    rows.push({ id: snapshot.subagentId, line: nodeLine(snapshot, theme, branchCol, isLast) });
  }
  if (expanded && isActive(snapshot)) {
    rows.push({ id: "", line: activityLine(snapshot, theme, branchCol, isLast, activityTitle) });
  }
  const childBranchCol = isRoot ? 2 : branchCol + 5;
  const childParentBranchCol = isRoot ? -1 : branchCol;
  snapshot.children.forEach((child, index) => {
    rows.push(...collectTreeRows(
      child,
      theme,
      expanded,
      activityTitle,
      childBranchCol,
      childParentBranchCol,
      index === snapshot.children.length - 1,
    ));
  });
  return rows;
}

export { collectTreeRows };

function hintLine(theme: Theme, expanded: boolean): string {
  return theme.fg("muted", `(ctrl+o to ${expanded ? "hide" : "show"} activity)`);
}

class SubagentTreeComponent implements Component {
  constructor(
    private readonly snapshot: SubagentSnapshot,
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly activityTitle?: ActivityTitleRenderer,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = [
      "",
      ...collectTreeRows(this.snapshot, this.theme, this.expanded, this.activityTitle).map((row) => row.line),
      "",
      hintLine(this.theme, this.expanded),
    ];
    return new Text(lines.join("\n"), 0, 0).render(width);
  }
}

class LevelTreeComponent implements Component {
  constructor(
    private readonly snapshots: readonly SubagentSnapshot[],
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly activityTitle?: ActivityTitleRenderer,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    this.snapshots.forEach((snapshot, index) => {
      const last = index === this.snapshots.length - 1;
      lines.push(nodeLine(snapshot, this.theme, 2, last));
      if (this.expanded && isActive(snapshot)) {
        lines.push(activityLine(snapshot, this.theme, 2, last, this.activityTitle));
      }
    });
    lines.push("", hintLine(this.theme, this.expanded));
    return new Text(lines.join("\n"), 0, 0).render(width);
  }
}

export function renderSubagentTree(
  snapshot: SubagentSnapshot,
  theme: Theme,
  expanded: boolean,
  activityTitle?: ActivityTitleRenderer,
): Component {
  return new SubagentTreeComponent(snapshot, theme, expanded, activityTitle);
}

export function renderLevelTree(
  snapshots: readonly SubagentSnapshot[],
  theme: Theme,
  expanded: boolean,
  activityTitle?: ActivityTitleRenderer,
): Component {
  return new LevelTreeComponent(snapshots, theme, expanded, activityTitle);
}
