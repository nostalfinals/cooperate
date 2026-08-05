import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SessionInspection, SessionRecord, SessionStore } from "../subagent/ports.ts";
import { compactPreview } from "../text.ts";

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
