import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { compactPreview } from "../text.ts";

export type MessageKind = "text" | "tool-call" | "custom" | "other";

export interface MessageSummary {
  id: string;
  role: string;
  kind: MessageKind;
  preview: string;
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function partsOf(message: { content?: unknown }): readonly ContentPart[] {
  const content = isRecord(message) ? message.content : undefined;
  return Array.isArray(content) ? (content as ContentPart[]) : [];
}

function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n");
}

/** One-line description of a message: tool calls are named, plain text is previewed. */
export function describeMessage(message: { role?: string; content?: unknown }, id: string): MessageSummary {
  const parts = partsOf(message);
  const toolNames = parts.filter((part) => part.type === "toolCall").map((part) => part.name ?? "unknown");
  const text = textOf(parts);
  if (toolNames.length > 0) {
    const preview = text.trim().length > 0 ? `${toolNames.join(", ")} — ${text}` : toolNames.join(", ");
    return { id, role: message.role ?? "assistant", kind: "tool-call", preview: compactPreview(preview) };
  }
  return { id, role: message.role ?? "assistant", kind: "text", preview: compactPreview(text) };
}

/** Latest user/assistant message in a live run, skipping tool results and metadata. */
export function describeLastMessage(messages: readonly unknown[]): MessageSummary | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "assistant" && role !== "user") continue;
    return describeMessage(message as { role?: string; content?: unknown }, "latest");
  }
  return undefined;
}

/** Depth-first entry order of a session tree (the original append order). */
export function flattenTree(nodes: readonly SessionTreeNode[]): readonly SessionEntry[] {
  const entries: SessionEntry[] = [];
  const visit = (list: readonly SessionTreeNode[]) => {
    for (const node of list) {
      entries.push(node.entry);
      visit(node.children);
    }
  };
  visit(nodes);
  return entries;
}

/** Message-like summaries of a session: messages and custom messages, in order. */
export function summarizeEntries(entries: readonly SessionEntry[]): readonly MessageSummary[] {
  const summaries: MessageSummary[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      summaries.push(describeMessage(entry.message as { role?: string; content?: unknown }, entry.id));
    } else if (entry.type === "custom_message") {
      const text = typeof entry.content === "string"
        ? entry.content
        : textOf(entry.content as ContentPart[]);
      summaries.push({ id: entry.id, role: "custom", kind: "custom", preview: compactPreview(text || entry.customType) });
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      summaries.push({ id: entry.id, role: entry.type, kind: "other", preview: compactPreview(entry.summary) });
    }
  }
  return summaries;
}

/** Full readable content of one session entry, for the history messageId drill-down. */
export function messageContent(entry: SessionEntry): string {
  if (entry.type === "message") {
    const parts = partsOf(entry.message as { content?: unknown });
    const sections: string[] = [];
    const text = textOf(parts);
    if (text.trim().length > 0) sections.push(text);
    for (const part of parts) {
      if (part.type !== "toolCall") continue;
      sections.push(`[tool call ${part.name ?? "unknown"}] ${JSON.stringify(part.arguments ?? {})}`);
    }
    if (sections.length === 0) return "<none>";
    return sections.join("\n\n");
  }
  if (entry.type === "custom_message") {
    const text = typeof entry.content === "string"
      ? entry.content
      : textOf(entry.content as ContentPart[]);
    return text.length > 0 ? text : "<none>";
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  return `<${entry.type}>`;
}
