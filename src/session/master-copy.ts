import { cp, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyDirectory } from "./history.ts";
import { pathExists } from "./filesystem.ts";

export function cooperateSessionsDirectory(agentDir: string): string {
  return resolve(agentDir, "cooperate", "sessions");
}

function assertValidSessionId(id: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

export interface MasterCopyOptions {
  stagingName?: string;
  copy?: (source: string, destination: string) => Promise<void>;
}

/** Atomically copy one master's complete child-session namespace. */
export async function copyMasterSessionDirectory(
  agentDir: string,
  sourceMasterId: string,
  destinationMasterId: string,
  options: MasterCopyOptions = {},
): Promise<void> {
  assertValidSessionId(sourceMasterId);
  assertValidSessionId(destinationMasterId);
  const root = cooperateSessionsDirectory(agentDir);
  const source = resolve(root, sourceMasterId);
  const destination = resolve(root, destinationMasterId);
  if (await pathExists(destination)) {
    throw new Error(`Cooperate session destination already exists: ${destination}`);
  }
  // A master with no children has no namespace to copy.
  if (!(await pathExists(source))) return;

  await mkdir(root, { recursive: true });
  const staging = resolve(
    root,
    options.stagingName ?? `.copy-${destinationMasterId}-${randomBytes(6).toString("hex")}`,
  );
  if (await pathExists(staging)) throw new Error(`Cooperate session staging destination already exists: ${staging}`);
  const copy = options.copy ?? ((from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false }));

  const historyFile = resolve(historyDirectory(agentDir), `${sourceMasterId}.jsonl`);
  const historyStaging = resolve(historyDirectory(agentDir), `.copy-${destinationMasterId}-${randomBytes(6).toString("hex")}.jsonl`);
  const hasHistory = await pathExists(historyFile);
  if (hasHistory && (await pathExists(historyStaging))) {
    throw new Error(`Cooperate history staging destination already exists: ${historyStaging}`);
  }
  try {
    await copy(source, staging);
    if (await pathExists(destination)) {
      throw new Error(`Cooperate session destination already exists: ${destination}`);
    }
    if (hasHistory) {
      await mkdir(dirname(historyStaging), { recursive: true });
      await copyFile(historyFile, historyStaging);
    }
    await rename(staging, destination);
    if (hasHistory) {
      const historyDestination = resolve(historyDirectory(agentDir), `${destinationMasterId}.jsonl`);
      await rename(historyStaging, historyDestination);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(historyStaging, { force: true });
    throw error;
  }
}

/** Read a master UUID through Pi's native session parser, not its filename. */
export function masterSessionIdFromFile(sessionFile: string): string {
  return SessionManager.open(sessionFile).getSessionId();
}
