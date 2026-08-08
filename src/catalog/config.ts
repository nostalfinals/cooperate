import { readFile } from "node:fs/promises";
import { CatalogError, type CooperateConfig } from "./types.ts";
import { errorCode, errorMessage, isRecord } from "./validation.ts";

export const DEFAULT_CONFIG = Object.freeze({
  maxDepth: 3,
  cleanOrphanSessions: true,
});

const CONFIG_FIELDS = new Set(["maxDepth", "cleanOrphanSessions"]);

export async function loadConfig(configPath: string): Promise<CooperateConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new CatalogError(configPath, `cannot read configuration: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CatalogError(configPath, `malformed JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(value)) throw new CatalogError(configPath, "must be a JSON object");
  for (const field of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(field)) throw new CatalogError(configPath, `unknown field '${field}'`);
  }

  const maxDepth = Object.hasOwn(value, "maxDepth") ? value.maxDepth : DEFAULT_CONFIG.maxDepth;
  if (!Number.isInteger(maxDepth) || (maxDepth as number) < 1) {
    throw new CatalogError(configPath, "maxDepth must be an integer of at least 1");
  }

  const cleanOrphanSessions = Object.hasOwn(value, "cleanOrphanSessions")
    ? value.cleanOrphanSessions
    : DEFAULT_CONFIG.cleanOrphanSessions;
  if (typeof cleanOrphanSessions !== "boolean") {
    throw new CatalogError(configPath, "cleanOrphanSessions must be a boolean");
  }

  return { maxDepth: maxDepth as number, cleanOrphanSessions };
}
