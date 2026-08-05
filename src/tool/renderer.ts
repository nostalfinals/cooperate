import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { SubagentActivity, SubagentSnapshot } from "../subagent/types.ts";
import {
  renderLevelTree,
  renderSubagentTree,
  type ActivityTitleRenderer,
} from "../ui/presentation.ts";

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

type ToolDefinitionProvider = (subagentId: string, toolName: string) => unknown;

let toolDefinitionProvider: ToolDefinitionProvider | undefined;

export function setToolDefinitionProvider(provider: ToolDefinitionProvider | undefined): void {
  toolDefinitionProvider = provider;
}

const ACTIVITY_MAX_WIDTH = 60;
const ACTIVITY_RENDER_WIDTH = 1000;

const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

const FAKE_RENDER_CONTEXT = {
  args: {},
  toolCallId: "activity",
  invalidate: () => {},
  lastComponent: undefined,
  state: {},
  cwd: "",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
};

function trimTrailingPadding(line: string): string {
  const visible = stripAnsi(line);
  const trailing = visible.length - visible.trimEnd().length;
  return trailing > 0 ? line.slice(0, line.length - trailing) : line;
}

function activityTitle(subagentId: string, activity: SubagentActivity, theme: Theme): string | undefined {
  const definition = toolDefinitionProvider?.(subagentId, activity.toolName) as ToolDefinition | undefined;
  if (!definition?.renderCall) return undefined;
  try {
    const component = definition.renderCall(activity.input, theme, {
      ...FAKE_RENDER_CONTEXT,
      args: activity.input,
    });
    const lines = component.render(ACTIVITY_RENDER_WIDTH);
    const title = lines.find((line) => stripAnsi(line).trim().length > 0);
    if (title === undefined) return undefined;
    const normalized = title.replace(/^(?:\x1b\[[0-9;]*m)*\$ /, `${theme.fg("toolTitle", activity.toolName)} `);
    return truncateToWidth(trimTrailingPadding(normalized), ACTIVITY_MAX_WIDTH, "…");
  } catch {
    return undefined;
  }
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
      return renderSubagentTree(snapshot, theme, options.expanded, activityTitle);
    }
    return new Text("", 0, 0);
  }

  if (action === "wait") {
    return renderLevelTree(details?.snapshots ?? [], theme, options.expanded, activityTitle);
  }

  if (action === "cancel") {
    const snapshot = details?.snapshot;
    if (!snapshot) return new Text("", 0, 0);
    return renderLevelTree([snapshot], theme, options.expanded, activityTitle);
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
