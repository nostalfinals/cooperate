import type { SessionTreeNode, Theme } from "@earendil-works/pi-coding-agent";

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

export interface HistoryRow {
  id: string;
  line: string;
}

export function normalize(text: string): string {
  return text.replace(/[\n\t]/g, " ").trim();
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text?: string } =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function collectToolCalls(roots: readonly SessionTreeNode[]): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  const visit = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      const entry = node.entry;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
              map.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> });
            }
          }
        }
      }
      visit(node.children);
    }
  };
  visit(roots);
  return map;
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const path = (): string => String(args.path ?? args.file_path ?? "");
  switch (name) {
    case "read": return `[read: ${path()}]`;
    case "write": return `[write: ${path()}]`;
    case "edit": return `[edit: ${path()}]`;
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string");
      return `[${name}${first !== undefined ? `: ${first}` : ""}]`;
    }
  }
}

export function entryDisplayText(entry: SessionTreeNode["entry"], theme: Theme, toolCalls: Map<string, ToolCallInfo>): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "user") {
        return theme.fg("accent", "user: ") + normalize(extractText(message.content));
      }
      if (message.role === "assistant") {
        const label = theme.fg("success", "assistant: ");
        const text = normalize(extractText(message.content));
        if (text) return label + text;
        if (message.stopReason === "aborted") return label + theme.fg("muted", "(aborted)");
        if (message.errorMessage) return label + theme.fg("error", normalize(message.errorMessage));
        return label + theme.fg("muted", "(no content)");
      }
      if (message.role === "toolResult") {
        const call = toolCalls.get(message.toolCallId);
        return theme.fg("muted", call ? formatToolCall(call.name, call.args) : `[${message.toolName}]`);
      }
      if (message.role === "bashExecution") {
        return theme.fg("dim", `[bash]: ${normalize(message.command ?? "")}`);
      }
      return theme.fg("dim", `[${message.role}]`);
    }
    case "compaction":
      return theme.fg("borderAccent", `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`);
    case "custom_message":
      return theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(extractText(entry.content));
    case "model_change":
      return theme.fg("dim", `[model: ${entry.modelId}]`);
    case "thinking_level_change":
      return theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
    default:
      return theme.fg("dim", `[${entry.type}]`);
  }
}

export function flattenTree(roots: readonly SessionTreeNode[], theme: Theme, toolCalls: Map<string, ToolCallInfo>): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const visit = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      rows.push({ id: node.entry.id, line: entryDisplayText(node.entry, theme, toolCalls) });
      visit(node.children);
    }
  };
  visit(roots);
  return rows;
}

export function fullMessageText(entry: SessionTreeNode["entry"]): string {
  if (entry.type !== "message") return "";
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): boolean =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

export function viewport<T>(rows: readonly T[], selectedIndex: number, maxVisible: number): T[] {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible));
  return rows.slice(start, start + maxVisible);
}
