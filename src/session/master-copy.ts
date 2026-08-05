import { constants } from "node:fs";
import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function cooperateSessionsDirectory(agentDir: string): string {
  return resolve(agentDir, "cooperate", "sessions");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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
  if (await exists(destination)) {
    throw new Error(`Cooperate session destination already exists: ${destination}`);
  }
  // A master with no children has no namespace to copy.
  if (!(await exists(source))) return;

  await mkdir(root, { recursive: true });
  const staging = resolve(
    root,
    options.stagingName ?? `.copy-${destinationMasterId}-${randomBytes(6).toString("hex")}`,
  );
  if (await exists(staging)) throw new Error(`Cooperate session staging destination already exists: ${staging}`);
  const copy = options.copy ?? ((from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false }));
  try {
    await copy(source, staging);
    if (await exists(destination)) {
      throw new Error(`Cooperate session destination already exists: ${destination}`);
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Read a master UUID through Pi's native session parser, not its filename. */
export function masterSessionIdFromFile(sessionFile: string): string {
  return SessionManager.open(sessionFile).getSessionId();
}
