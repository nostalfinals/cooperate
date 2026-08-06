import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentActivity } from "../subagent/types.ts";

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

export function renderActivityTitle(subagentId: string, activity: SubagentActivity, theme: Theme): string | undefined {
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
