import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./subagent/types.ts";
import type { CompletionNotice } from "./continuation.ts";
import { compactPreview } from "./sessions.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function snapshotElapsed(snapshot: SubagentSnapshot): number {
  return snapshot.state === "running" || snapshot.state === "waiting"
    ? Math.max(snapshot.elapsedMs, Date.now() - snapshot.startedAt)
    : snapshot.elapsedMs;
}

function stateMark(snapshot: SubagentSnapshot, theme: Theme): string {
  switch (snapshot.state) {
    case "running": return theme.fg("accent", SPINNER[Math.floor(snapshotElapsed(snapshot) / 120) % SPINNER.length]!);
    case "waiting": return theme.fg("warning", "◌");
    case "finished": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "×");
    case "cancelled": return theme.fg("warning", "–");
  }
}

function treeLines(snapshot: SubagentSnapshot, theme: Theme, expanded: boolean, prefix = "", connector = ""): string[] {
  const line = prefix + connector + stateMark(snapshot, theme) + " "
    + theme.fg("accent", snapshot.agent) + " "
    + theme.fg("muted", snapshot.subagentId) + " "
    + theme.fg("muted", formatElapsed(snapshotElapsed(snapshot))) + " "
    + (expanded ? snapshot.task : compactPreview(snapshot.task, 80));
  const lines = [line];
  if (expanded) {
    lines.push(prefix + (connector ? "   " : "") + theme.fg("dim",
      `model ${snapshot.model ?? "unknown"} · thinking ${snapshot.thinking ?? "unknown"} · session ${snapshot.sessionId}`));
    if (snapshot.reason) lines.push(prefix + (connector ? "   " : "") + theme.fg(snapshot.state === "failed" ? "error" : "warning", `${snapshot.state}: ${snapshot.reason}`));
  }
  snapshot.children.forEach((child, index) => {
    const last = index === snapshot.children.length - 1;
    lines.push(...treeLines(child, theme, expanded, prefix + (connector ? (connector === "└─ " ? "   " : "│  ") : ""), last ? "└─ " : "├─ "));
  });
  return lines;
}

class SubagentTreeComponent implements Component {
  constructor(
    private readonly snapshot: SubagentSnapshot,
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly trailingText?: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = treeLines(this.snapshot, this.theme, this.expanded);
    if (this.expanded && this.trailingText) lines.push("", this.trailingText);
    return new Text(lines.join("\n"), 0, 0).render(width);
  }
}

export function renderSubagentTree(snapshot: SubagentSnapshot, theme: Theme, expanded: boolean, trailingText?: string): Component {
  return new SubagentTreeComponent(snapshot, theme, expanded, trailingText);
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
    text += "\n" + theme.fg("muted", `Session: ${notice.sessionId} · ${formatElapsed(notice.elapsedMs)}`);
  }
  box.addChild(new Text(text, 0, 0));
  return box;
}
