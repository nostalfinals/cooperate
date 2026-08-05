import { constants } from "node:fs";
import { access, opendir, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cooperateSessionsDirectory } from "./master-copy.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upper bound for a session header line. Real headers are well under 1KB; the
 * bound only guards against pathological files. Lines beyond it are treated
 * like corrupt headers (the session id is not collected).
 */
const MAX_HEADER_LINE_BYTES = 1024 * 1024;

/** Read just the first line of a JSONL file without loading the whole file. */
async function readFirstLine(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(8192);
    let total = 0;
    while (total < MAX_HEADER_LINE_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(chunk));
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function jsonlFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const files: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

export async function collectMasterSessionIds(
  agentDir: string,
  additionalSessionDirectories: readonly string[] = [],
): Promise<Set<string>> {
  const ids = new Set<string>();
  const roots = new Set([
    resolve(agentDir, "sessions"),
    ...additionalSessionDirectories.map((path) => resolve(path)),
  ]);
  const files = (await Promise.all([...roots].map(jsonlFiles))).flat();
  for (const file of files) {
    try {
      const firstLine = await readFirstLine(file);
      if (firstLine === undefined) continue;
      const header = JSON.parse(firstLine) as { type?: string; id?: string };
      if (header.type === "session" && typeof header.id === "string") ids.add(header.id);
    } catch {
      // Pi also ignores invalid session files when listing native sessions
    }
  }
  return ids;
}

export async function selectOrphanSessionDirectories(
  sessionsRoot: string,
  existingMasterIds: ReadonlySet<string>,
): Promise<string[]> {
  if (!(await exists(sessionsRoot))) return [];
  const orphans: string[] = [];
  const entries = await opendir(sessionsRoot);
  for await (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !existingMasterIds.has(entry.name)) {
      orphans.push(resolve(sessionsRoot, entry.name));
    }
  }
  return orphans.sort();
}

export interface OrphanCleanupOptions {
  /** Return false only when no trash facility is available. */
  trash?: (path: string) => Promise<boolean>;
  /** Abort before the next removal when this returns false (checked synchronously per path). */
  shouldProceed?: () => boolean;
}

const execFileAsync = promisify(execFile);
async function systemTrash(path: string): Promise<boolean> {
  const candidates: readonly [string, string[]][] = process.platform === "darwin"
    ? [["trash", [path]]]
    : [["gio", ["trash", path]], ["trash-put", [path]], ["trash", [path]]];
  for (const [command, args] of candidates) {
    try {
      await execFileAsync(command, args);
      return true;
    } catch {
      // Try another desktop trash implementation, then use approved removal.
    }
  }
  return false;
}

/** Remove namespaces whose owning native master session was deleted. */
export async function garbageCollectOrphanSessions(
  agentDir: string,
  existingMasterIds: ReadonlySet<string>,
  options: OrphanCleanupOptions = {},
): Promise<string[]> {
  const orphans = await selectOrphanSessionDirectories(cooperateSessionsDirectory(agentDir), existingMasterIds);
  const trash = options.trash ?? systemTrash;
  const handled: string[] = [];
  for (const path of orphans) {
    // Synchronous check with no await between it and the trash call, so a
    // stale background run cannot remove a namespace that a newer session
    // replacement (e.g. a fork copy) just created.
    if (options.shouldProceed && !options.shouldProceed()) break;
    if (!(await trash(path))) await rm(path, { recursive: true, force: true });
    handled.push(path);
  }
  return handled;
}
