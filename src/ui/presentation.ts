import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentActivity, SubagentSnapshot } from "../subagent/types.ts";
import type { CompletionNotice } from "../subagent/messenger.ts";
import { compactPreview } from "../text.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function snapshotElapsed(snapshot: SubagentSnapshot): number {
  return snapshot.state === "running" || snapshot.state === "waiting"
    ? Math.max(snapshot.elapsedMs, Date.now() - snapshot.startedAt)
    : snapshot.elapsedMs;
}

function stateMark(snapshot: SubagentSnapshot, theme: Theme): string {
  switch (snapshot.state) {
    case "running": return theme.fg("accent", SPINNER[Math.floor(snapshotElapsed(snapshot) / SPINNER_INTERVAL_MS) % SPINNER.length]!);
    case "waiting": return theme.fg("warning", "◌");
    case "finished": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "×");
    case "cancelled": return theme.fg("warning", "–");
  }
}

function isActive(snapshot: SubagentSnapshot): boolean {
  return snapshot.state === "running" || snapshot.state === "waiting";
}

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

function collectTreeLines(
  snapshot: SubagentSnapshot,
  theme: Theme,
  expanded: boolean,
  activityTitle: ActivityTitleRenderer | undefined,
  branchCol = -1,
  parentBranchCol = -1,
  isLast = true,
): string[] {
  const isRoot = branchCol < 0;
  const lines: string[] = [];
  if (isRoot) {
    lines.push(nodeLine(snapshot, theme, -1, true));
  } else if (parentBranchCol >= 0) {
    lines.push(
      " ".repeat(parentBranchCol) + theme.fg("muted", "│") + " ".repeat(branchCol - parentBranchCol - 1)
        + theme.fg("muted", isLast ? "└─" : "├─") + " " + nodeBody(snapshot, theme),
    );
  } else {
    lines.push(nodeLine(snapshot, theme, branchCol, isLast));
  }
  if (expanded && isActive(snapshot)) {
    lines.push(activityLine(snapshot, theme, branchCol, isLast, activityTitle));
  }
  const childBranchCol = isRoot ? 2 : branchCol + 5;
  const childParentBranchCol = isRoot ? -1 : branchCol;
  snapshot.children.forEach((child, index) => {
    lines.push(...collectTreeLines(
      child,
      theme,
      expanded,
      activityTitle,
      childBranchCol,
      childParentBranchCol,
      index === snapshot.children.length - 1,
    ));
  });
  return lines;
}

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
      ...collectTreeLines(this.snapshot, this.theme, this.expanded, this.activityTitle),
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

export function renderCompletionMessage(
  message: { content: string | Array<{ type: string; text?: string }>; details?: CompletionNotice },
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const notice = message.details;
  const title = theme.fg("customMessageLabel", theme.bold("[subagent]"));
  if (!notice) {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    box.addChild(new Text(`${title}\n${theme.fg("customMessageText", content)}`, 0, 0));
    return box;
  }

  const stateColor = notice.state === "finished" ? "success" : notice.state === "failed" ? "error" : "warning";
  let text = title + "\n"
    + theme.fg("customMessageText", "Subagent ")
    + theme.fg("accent", notice.agent) + " "
    + theme.fg(stateColor, notice.state)
    + theme.fg("muted", " (ctrl+o to expand)");
  if (options.expanded) {
    const body = notice.state === "finished" ? notice.result ?? "<none>" : notice.reason ?? notice.state;
    text += `\n\n${theme.fg("customMessageText", body)}`;
    text += "\n" + theme.fg("muted", `session: ${notice.sessionId} · ${formatElapsed(notice.elapsedMs)}`);
  }
  box.addChild(new Text(text, 0, 0));
  return box;
}
