import { constants } from "node:fs";
import { access, opendir, readFile, rm } from "node:fs/promises";
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

/** Discover valid native master Sessions in Pi's default and active Session trees. */
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
      const firstLine = (await readFile(file, "utf8")).split("\n", 1)[0];
      const header = JSON.parse(firstLine) as { type?: string; id?: string };
      if (header.type === "session" && typeof header.id === "string") ids.add(header.id);
    } catch {
      // Pi also ignores invalid Session files when listing native Sessions.
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

/** Remove namespaces whose owning native master Session was deleted. */
export async function garbageCollectOrphanSessions(
  agentDir: string,
  existingMasterIds: ReadonlySet<string>,
  options: OrphanCleanupOptions = {},
): Promise<string[]> {
  const orphans = await selectOrphanSessionDirectories(cooperateSessionsDirectory(agentDir), existingMasterIds);
  const trash = options.trash ?? systemTrash;
  for (const path of orphans) {
    if (!(await trash(path))) await rm(path, { recursive: true, force: true });
  }
  return orphans;
}
