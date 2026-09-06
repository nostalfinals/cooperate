import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../subagent/types.ts";
import { renderLevelTree } from "../ui/tree.ts";
import { renderActivityTitle } from "./activity-title.ts";
import { compactPreview } from "../text.ts";

type ToolRenderContextArg = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface SubagentToolDetails {
  action: string;
  subagentId?: string;
  sessionId?: string;
  count?: number;
  all?: boolean;
  snapshot?: SubagentSnapshot;
  snapshots?: readonly SubagentSnapshot[];
}

export function renderCall(args: unknown, theme: Theme): Text {
  const action = (args as { action: string }).action;
  const header = theme.fg("toolTitle", theme.bold("subagent")) + " ";
  switch (action) {
    case "run": {
      const run = args as { agent: string };
      return new Text(header + theme.fg("accent", `run ${run.agent}`), 0, 0);
    }
    default:
      return new Text(header + theme.fg("accent", action), 0, 0);
  }
}

function errorComponent(result: AgentToolResult<unknown>, theme: Theme): Text {
  return new Text("\n" + theme.fg("muted", errorText(result)), 0, 0);
}

function errorText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function renderResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextArg,
): Component {
  const details = result.details as SubagentToolDetails | undefined;
  const action = details?.action ?? (context.args as { action?: string }).action;

  if (action === "run") {
    if (context.isError) {
      const text = errorText(result);
      return new Text("\n" + theme.fg("muted", text), 0, 0);
    }
    const snapshot = details?.snapshot;
    if (!snapshot) return new Text("", 0, 0);
    const text = theme.fg("accent", snapshot.agent)
      + theme.fg("muted", ` · ${compactPreview(snapshot.task, 80)}`);
    return new Text("\n" + text, 0, 0);
  }

  if (action === "inspect") {
    if (context.isError) return errorComponent(result, theme);
    const snapshot = details?.snapshot;
    if (!snapshot) return new Text("", 0, 0);
    return renderLevelTree([snapshot], theme, options.expanded, renderActivityTitle);
  }

  if (action === "history") {
    if (context.isError) return errorComponent(result, theme);
    return new Text("", 0, 0);
  }

  if (action === "steer") {
    if (context.isError) return errorComponent(result, theme);
    return new Text("", 0, 0);
  }

  if (action === "cancel") {
    const snapshot = details?.snapshot;
    if (!snapshot) return context.isError ? errorComponent(result, theme) : new Text("", 0, 0);
    return renderLevelTree([snapshot], theme, options.expanded, renderActivityTitle);
  }

  if (action === "list-definitions") {
    const count = details?.count ?? 0;
    const text = count === 0
      ? "No subagent is defined yet"
      : `${count} definition${count === 1 ? "" : "s"}`;
    return new Text("\n" + theme.fg("muted", text), 0, 0);
  }
  if (action === "list-subagents") {
    const count = details?.count ?? 0;
    const text = count === 0
      ? "No subagent is active yet"
      : details?.all === true
        ? `${count} direct subagent${count === 1 ? "" : "s"} (including completed)`
        : `${count} active subagent${count === 1 ? "" : "s"}`;
    return new Text("\n" + theme.fg("muted", text), 0, 0);
  }
  if (action === "list-sessions") {
    const count = details?.count ?? 0;
    const text = count === 0
      ? "No session yet"
      : `${count} session${count === 1 ? "" : "s"}`;
    return new Text("\n" + theme.fg("muted", text), 0, 0);
  }

  return new Text("", 0, 0);
}
