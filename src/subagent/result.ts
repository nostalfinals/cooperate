function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAbortedAgentEnd(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

export function completionTitle(agent: string, state: "finished" | "failed" | "cancelled", subagentId: string, sessionId: string): string {
  return `Subagent ${agent} ${state} (subagentId=${subagentId}, sessionId=${sessionId})`;
}

export function extractFinalText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text;
      }
    }
    return "<none>";
  }
  return "<none>";
}
