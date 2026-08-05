import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../subagent/types.ts";
import { renderSubagentTree } from "../ui/presentation.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface SubagentToolDetails {
  action: string;
  async?: boolean;
  subagentId?: string;
  sessionId?: string;
  count?: number;
  snapshot?: SubagentSnapshot;
}

export function renderCall(args: unknown, theme: Theme): Text {
  const action = (args as { action: string }).action;
  let header = theme.fg("toolTitle", theme.bold(`subagent ${action}`));
  if (action === "run") {
    const run = args as { agent: string; async?: boolean };
    header = theme.fg("toolTitle", theme.bold("subagent run ")) + theme.fg("accent", run.agent);
    if (run.async) header += theme.fg("muted", " (async)");
  } else if (action === "wait") {
    const ids = (args as { subagentIds: string[] }).subagentIds;
    header = theme.fg("toolTitle", theme.bold("subagent wait ")) + theme.fg("accent", ids.join(", "));
  } else if (action === "cancel") {
    const id = (args as { subagentId: string }).subagentId;
    header = theme.fg("toolTitle", theme.bold("subagent cancel ")) + theme.fg("accent", id);
  }
  return new Text(header, 0, 0);
}

export function renderResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const details = result.details as SubagentToolDetails | undefined;
  const renderState = context.state as { snapshot?: SubagentSnapshot } | undefined;
  if (details?.snapshot && renderState) renderState.snapshot = details.snapshot;
  const snapshot = details?.snapshot ?? renderState?.snapshot;
  const action = details?.action ?? (context.args as { action?: string }).action;
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (action === "run" && snapshot && !details?.async && !(context.args as { async?: boolean }).async) {
    return renderSubagentTree(snapshot, theme, options.expanded, text);
  }
  if (options.expanded) return new Text(text, 0, 0);
  if (details?.action === "run" && details.async && details.subagentId) {
    return new Text(theme.fg("success", `started ${details.subagentId}`), 0, 0);
  }
  if (details?.action === "list-subagents") {
    const count = details.count ?? 0;
    return new Text(theme.fg("muted", `${count} active subagent${count === 1 ? "" : "s"}`), 0, 0);
  }
  if (details?.action === "list-sessions") {
    const count = details.count ?? 0;
    return new Text(theme.fg("muted", `${count} session${count === 1 ? "" : "s"}`), 0, 0);
  }
  if (details?.action === "list-definitions") {
    const count = details.count ?? 0;
    return new Text(theme.fg("muted", `${count} definition${count === 1 ? "" : "s"}`), 0, 0);
  }
  if (action === "wait" || action === "cancel") return new Text("", 0, 0);
  return new Text(text, 0, 0);
}
