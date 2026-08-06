import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../subagent/types.ts";
import { renderLevelTree, renderSubagentTree } from "../ui/tree.ts";
import { renderActivityTitle } from "./activity-title.ts";

type ToolRenderContextArg = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface SubagentToolDetails {
  action: string;
  async?: boolean;
  subagentId?: string;
  sessionId?: string;
  count?: number;
  snapshot?: SubagentSnapshot;
  snapshots?: readonly SubagentSnapshot[];
}

export function renderCall(args: unknown, theme: Theme): Text {
  const action = (args as { action: string }).action;
  const header = theme.fg("toolTitle", theme.bold("subagent")) + " ";
  switch (action) {
    case "run": {
      const run = args as { agent: string; async?: boolean };
      let line = header + theme.fg("accent", `run ${run.agent}`);
      if (run.async) line += theme.fg("muted", " (async)");
      return new Text(line, 0, 0);
    }
    case "wait":
    case "cancel":
    case "list-definitions":
    case "list-subagents":
    case "list-sessions":
      return new Text(header + theme.fg("accent", action), 0, 0);
    default:
      return new Text(header + theme.fg("accent", action), 0, 0);
  }
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
    const asyncRun = details?.async === true || (context.args as { async?: boolean }).async === true;
    if (snapshot && !asyncRun) {
      return renderSubagentTree(snapshot, theme, options.expanded, renderActivityTitle);
    }
    return new Text("", 0, 0);
  }

  if (action === "wait") {
    return renderLevelTree(details?.snapshots ?? [], theme, options.expanded, renderActivityTitle);
  }

  if (action === "cancel") {
    const snapshot = details?.snapshot;
    if (!snapshot) return new Text("", 0, 0);
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
