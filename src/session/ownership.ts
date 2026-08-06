export const OWNERSHIP_ENTRY = "cooperate.subagent-session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function ownedSessionIds(branch: readonly unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== OWNERSHIP_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof data.sessionId !== "string" || seen.has(data.sessionId)) continue;
    ids.push(data.sessionId);
    seen.add(data.sessionId);
  }
  return ids;
}
