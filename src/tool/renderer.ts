import {
  keyText,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../subagent/types.ts";
import { renderLevelTree, renderSubagentTree } from "../ui/tree.ts";
import { renderActivityTitle } from "./activity-title.ts";
import { compactPreview } from "../text.ts";
import { formatElapsed } from "../ui/presentation.ts";
import type { SubagentHistoryResult, SubagentInspection } from "../subagent/messages.ts";

type ToolRenderContextArg = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface SubagentToolDetails {
  action: string;
  subagentId?: string;
  sessionId?: string;
  count?: number;
  all?: boolean;
  snapshot?: SubagentSnapshot;
  snapshots?: readonly SubagentSnapshot[];
  inspection?: SubagentInspection;
  history?: SubagentHistoryResult;
}

export function renderCall(args: unknown, theme: Theme, agent?: string, details?: SubagentToolDetails): Text {
  const action = (args as { action: string }).action;
  const header = theme.fg("toolTitle", theme.bold("subagent")) + " ";
  switch (action) {
    case "run": {
      const run = args as { agent: string };
      return new Text(header + theme.fg("accent", `run ${run.agent}`), 0, 0);
    }
    case "steer": {
      return new Text(header + theme.fg("accent", `steer ${agent ?? "unknown subagent"}`), 0, 0);
    }
    case "inspect":
    case "history": {
      const params = args as { messageId?: string; offset?: number; limit?: number; text?: string };
      let line = header + theme.fg("accent", action);
      line += theme.fg("accent", ` ${agent ?? details?.snapshot?.agent ?? "unknown subagent"}`);
      if (action === "history") {
        const page = details?.history;
        if (params.messageId) {
          line += theme.fg("muted", ` · message ${params.messageId}`);
        } else if (page && "messages" in page) {
          line += theme.fg("muted", page.messages.length > 0
            ? ` · ${page.offset + 1}..${page.offset + page.messages.length}`
            : " · no messages");
        } else {
          const start = (params.offset ?? 0) + 1;
          line += theme.fg("muted", ` · ${start}..${start + (params.limit ?? 50) - 1}`);
        }
      }
      return new Text(line, 0, 0);
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

  if (context.isError) {
    const args = context.args as { subagentId?: unknown };
    const invalidId = ["inspect", "history", "steer", "cancel"].includes(action ?? "")
      && (typeof args.subagentId !== "string" || !/^[0-9a-f]{8}$/.test(args.subagentId));
    const text = invalidId
      ? "Use the short subagent ID from list-subagents, not a session ID."
      : compactPreview(errorText(result).split("\n")[0] ?? "Unable to complete this request.", 180);
    return new Text("\n" + theme.fg("error", text)
      + (options.expanded ? "\n" + theme.fg("muted", errorText(result)) : ""), 0, 0);
  }

  if (action === "run") {
    const snapshot = details?.snapshot;
    if (!snapshot) return new Text("", 0, 0);
    return renderSubagentTree(snapshot, theme, options.expanded, renderActivityTitle);
  }

  if (action === "inspect") {
    const inspection = details?.inspection;
    if (!inspection) return new Text("", 0, 0);
    const line = `${inspection.state} · ${formatElapsed(inspection.elapsedMs)} · ${compactPreview(inspection.task, 80)}`;
    return new Text("\n" + theme.fg("muted", line), 0, 0);
  }

  if (action === "history") {
    const history = details?.history;
    if (!history) return new Text("", 0, 0);
    if ("message" in history) {
      return new Text("\n" + theme.fg("muted", options.expanded ? history.message : compactPreview(history.message, 200)), 0, 0);
    }
    const visible = options.expanded ? history.messages : history.messages.slice(0, 3);
    const lines = visible.map((message, index) => {
      const role = message.kind === "tool-call" ? `${message.role} → tool` : message.role;
      return `${history.offset + index + 1} · ${role} · ${compactPreview(message.preview, options.expanded ? 300 : 100)}`;
    });
    const remaining = history.messages.length - visible.length;
    if (remaining > 0) {
      lines.push(`\n(${remaining} more ${remaining === 1 ? "line" : "lines"}, ${keyText("app.tools.expand")} to expand)`);
    }
    if (lines.length === 0) lines.push("No messages in this range.");
    return new Text("\n" + lines.map((line) => theme.fg("muted", line)).join("\n"), 0, 0);
  }

  if (action === "steer") {
    const text = (context.args as { text?: string }).text ?? "";
    return new Text("\n" + theme.fg("muted", compactPreview(text, 200)), 0, 0);
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
