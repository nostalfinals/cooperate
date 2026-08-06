import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { compactPreview } from "../text.ts";
import type { ActiveSubagentState, SubagentSnapshot, TerminalSubagentState } from "../subagent/types.ts";
import type { CompletionNotice } from "../subagent/messenger.ts";

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

export function stateMark(state: ActiveSubagentState | TerminalSubagentState, theme: Theme, elapsedMs = 0): string {
  switch (state) {
    case "running": return theme.fg("accent", SPINNER[Math.floor(elapsedMs / SPINNER_INTERVAL_MS) % SPINNER.length]!);
    case "waiting": return theme.fg("warning", "◌");
    case "finished": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "×");
    case "cancelled": return theme.fg("warning", "–");
  }
}

export function renderCompletionMessage(
  message: { content: string | Array<{ type: string; text?: string }>; details?: CompletionNotice },
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const notice = message.details;
  if (!notice) {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    box.addChild(new Text(`${theme.fg("customMessageLabel", theme.bold("[subagent]"))}\n${theme.fg("customMessageText", content)}`, 0, 0));
    return box;
  }

  let text = stateMark(notice.state, theme) + " " + theme.fg("accent", notice.agent)
    + theme.fg("muted", ` · ${formatElapsed(notice.elapsedMs)}`);
  if (notice.task) text += theme.fg("muted", ` · ${compactPreview(notice.task, 80)}`);
  const expandable = notice.state !== "cancelled"
    && (notice.state === "failed" || (notice.result !== undefined && notice.result !== "<none>"));
  if (expandable) {
    if (options.expanded) {
      const body = notice.state === "finished" ? notice.result! : (notice.reason ?? notice.state);
      text += `\n\n${theme.fg("customMessageText", body)}`;
    } else {
      text += "\n\n" + theme.fg("muted", "(ctrl+o to expand)");
    }
  }
  box.addChild(new Text(text, 0, 0));
  return box;
}
