import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionManager,
  truncateHead,
  truncateTail,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const OWNERSHIP_ENTRY = "cooperate.child-session";

export interface SessionRecord {
  sessionId: string;
  file: string;
  native?: unknown;
}

export interface SessionInspection {
  task: string;
  result: string;
}

export interface SessionStore {
  create(): Promise<SessionRecord>;
  open(sessionId: string): Promise<SessionRecord>;
  list(): Promise<readonly SessionRecord[]>;
  inspect(record: SessionRecord): Promise<SessionInspection>;
}

export interface NativeSessionStoreOptions {
  agentDir: string;
  masterSessionId: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function lastAssistantText(entries: readonly SessionEntry[], after: number): string {
  for (let index = entries.length - 1; index > after; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (let part = entry.message.content.length - 1; part >= 0; part--) {
      const content = entry.message.content[part];
      if (content.type === "text" && content.text.trim().length > 0) return content.text;
    }
    return "<none>";
  }
  return "<none>";
}

export function compactPreview(value: string, maxLength = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "<none>";
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

export function truncateForTool(value: string): string {
  const head = truncateHead(value);
  if (!head.truncated || head.content.length > 0) return head.content;
  // Pi's head truncator deliberately returns no partial first line. Final
  // replies can legitimately be one long line, so retain Pi's bounded tail
  // rather than turning a nonempty result into an empty tool response.
  return truncateTail(value).content;
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

export class NativeSessionStore implements SessionStore {
  readonly directory: string;
  private readonly cwd: string;

  constructor(options: NativeSessionStoreOptions) {
    this.cwd = options.cwd;
    this.directory = resolve(options.agentDir, "cooperate", "sessions", options.masterSessionId);
  }

  async create(): Promise<SessionRecord> {
    const allocated = SessionManager.create(this.cwd, this.directory);
    const allocatedFile = allocated.getSessionFile();
    if (!allocatedFile) throw new Error("Pi did not allocate a persistent child Session file");
    const file = resolve(allocatedFile);
    // Pi intentionally delays its first write until an assistant response. We
    // persist the native header immediately so startup/auth failures still leave
    // the approved resumable Session, then reopen through SessionManager so all
    // subsequent writes use Pi's normal append path.
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(allocated.getHeader())}\n`, { encoding: "utf8", flag: "wx" });
    const manager = SessionManager.open(file, this.directory, this.cwd);
    return { sessionId: manager.getSessionId(), file, native: manager };
  }

  async open(sessionId: string): Promise<SessionRecord> {
    const info = (await SessionManager.list(this.cwd, this.directory)).find((item) => item.id === sessionId);
    if (!info) throw new Error(`Session '${sessionId}' does not exist in the current master namespace`);
    const file = resolve(info.path);
    return {
      sessionId,
      file,
      native: SessionManager.open(file, this.directory, this.cwd),
    };
  }

  async list(): Promise<readonly SessionRecord[]> {
    return (await SessionManager.list(this.cwd, this.directory)).map((item) => ({
      sessionId: item.id,
      file: resolve(item.path),
    }));
  }

  async inspect(record: SessionRecord): Promise<SessionInspection> {
    // Reopen so listing observes all flushed writes even when the record was
    // created before a different runtime opened the same native file.
    const manager = SessionManager.open(record.file, this.directory, this.cwd);
    const entries = manager.getBranch();
    let latestUser = -1;
    let task = "<none>";
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type === "message" && entry.message.role === "user") {
        latestUser = index;
        task = compactPreview(textContent(entry.message.content));
        break;
      }
    }
    return { task, result: compactPreview(lastAssistantText(entries, latestUser)) };
  }
}
