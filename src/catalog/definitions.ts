import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { CatalogError, type CooperateConfig, type DefinitionModel, type ThinkingLevel } from "./types.ts";

export type SystemPromptMode = "append" | "override";

/** Wildcard entry for the `tools` and `subagents` fields: denotes the full set. */
export const WILDCARD = "*";

export const EXCLUSION_PREFIX = "-";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: readonly string[];
  subagentAgents: readonly string[];
  model?: DefinitionModel;
  thinking?: ThinkingLevel;
  /** How the Markdown body is applied to the subagent system prompt; absent means "append". */
  systemPromptMode?: SystemPromptMode;
  body: string;
  filePath: string;
}

export interface DefinitionCatalog {
  config: CooperateConfig;
  definitions: readonly AgentDefinition[];
  configPath: string;
  definitionsPath: string;
}

const DEFINITION_CONFIG_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "subagents",
  "model",
  "thinking",
  "system-prompt-mode",
]);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ExtractedFrontmatter {
  yaml: string;
  body: string;
}

function extractFrontmatter(source: string, filePath: string): ExtractedFrontmatter {
  const opening = /^(?:---\n|---\r\n)/.exec(source);
  if (!opening) throw new CatalogError(filePath, "YAML frontmatter is required");

  const closing = /^---(?:\n|\r\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(source);
  if (!match) throw new CatalogError(filePath, "YAML frontmatter closing delimiter is required");

  return {
    yaml: source.slice(opening[0].length, match.index),
    body: source.slice(match.index + match[0].length),
  };
}

function parseFrontmatter(yaml: string, filePath: string): Record<string, unknown> {
  const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    const first = document.errors[0];
    const message = first instanceof Error ? first.message : String(first);
    const hint = message.startsWith("Alias cannot be an empty string")
      ? " (a bare '*' is a YAML alias indicator; write \"*\" in quotes)"
      : "";
    throw new CatalogError(filePath, `malformed YAML: ${message}${hint}`);
  }

  const value: unknown = document.toJS();
  if (!isRecord(value)) throw new CatalogError(filePath, "frontmatter must be a YAML mapping");
  return value;
}

function requiredString(frontmatter: Record<string, unknown>, field: "name" | "description", filePath: string): string {
  const value = frontmatter[field];
  if (typeof value !== "string") throw new CatalogError(filePath, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new CatalogError(filePath, `${field} must be nonempty`);
  return trimmed;
}

function optionalString(frontmatter: Record<string, unknown>, field: string, filePath: string): string | undefined {
  const value = frontmatter[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CatalogError(filePath, `${field} must be a string`);
  return value.trim();
}

function commaSeparatedList(frontmatter: Record<string, unknown>, field: string, filePath: string): readonly string[] {
  const value = frontmatter[field];
  if (value === undefined) return [];
  if (typeof value !== "string") {
    throw new CatalogError(filePath, `${field} must be a comma-separated string`);
  }

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new CatalogError(filePath, `${field} contains an empty entry`);
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) throw new CatalogError(filePath, `${field} contains duplicate entry '${entry}'`);
    seen.add(entry);
  }

  const hasWildcard = entries.includes(WILDCARD);
  for (const entry of entries) {
    if (!isExclusionEntry(entry)) continue;
    const excluded = exclusionName(entry);
    if (excluded === undefined) throw new CatalogError(filePath, `${field} contains an empty exclusion`);
    if (excluded === WILDCARD) throw new CatalogError(filePath, `${field} cannot exclude '${WILDCARD}'`);
    if (!hasWildcard) throw new CatalogError(filePath, `${field} exclusion '${entry}' requires '${WILDCARD}'`);
  }
  if (hasWildcard && entries.some((entry) => entry !== WILDCARD && !isExclusionEntry(entry))) {
    throw new CatalogError(filePath, `${field} cannot combine '${WILDCARD}' with named entries`);
  }
  return entries;
}

export function isExclusionEntry(entry: string): boolean {
  return entry.startsWith(EXCLUSION_PREFIX);
}

export function exclusionName(entry: string): string | undefined {
  return isExclusionEntry(entry) ? entry.slice(EXCLUSION_PREFIX.length) : undefined;
}

export function excludedNames(entries: readonly string[]): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const entry of entries) {
    const name = exclusionName(entry);
    if (name !== undefined) excluded.add(name);
  }
  return excluded;
}

export function resolveEntries(entries: readonly string[], universe: readonly string[]): string[] {
  if (!entries.includes(WILDCARD)) return [...entries];
  const excluded = excludedNames(entries);
  return universe.filter((name) => !excluded.has(name));
}

/** Whether the entries are exactly the wildcard, i.e. denote the full set. */
export function isWildcard(entries: readonly string[]): boolean {
  return entries.length === 1 && entries[0] === WILDCARD;
}

/** Whether the entries include the given entry, with the wildcard implying everything. */
export function includesEntry(entries: readonly string[], entry: string): boolean {
  if (entries.includes(entry)) return true;
  return entries.includes(WILDCARD) && !entries.includes(`${EXCLUSION_PREFIX}${entry}`);
}

function parseModel(value: string | undefined, filePath: string): DefinitionModel | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CatalogError(filePath, "model must use provider/modelId with both parts nonempty");
  }
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
    reference: value,
  };
}

function parseThinking(value: string | undefined, filePath: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new CatalogError(filePath, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevel;
}

function parseSystemPromptMode(value: string | undefined, filePath: string): SystemPromptMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "append" && value !== "override") {
    throw new CatalogError(filePath, `system-prompt-mode must be "append" or "override"`);
  }
  return value;
}

async function loadDefinition(filePath: string): Promise<AgentDefinition> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CatalogError(filePath, `cannot read definition: ${errorMessage(error)}`);
  }

  const extracted = extractFrontmatter(source, filePath);
  const frontmatter = parseFrontmatter(extracted.yaml, filePath);
  for (const field of Object.keys(frontmatter)) {
    if (!DEFINITION_CONFIG_FIELDS.has(field)) {
      throw new CatalogError(filePath, `unknown frontmatter field '${field}'`);
    }
  }

  const name = requiredString(frontmatter, "name", filePath);
  if (!NAME_PATTERN.test(name)) throw new CatalogError(filePath, "name must match ^[A-Za-z0-9_-]+$");
  const description = requiredString(frontmatter, "description", filePath);

  return {
    name,
    description,
    tools: commaSeparatedList(frontmatter, "tools", filePath),
    subagentAgents: commaSeparatedList(frontmatter, "subagents", filePath),
    model: parseModel(optionalString(frontmatter, "model", filePath), filePath),
    thinking: parseThinking(optionalString(frontmatter, "thinking", filePath), filePath),
    systemPromptMode: parseSystemPromptMode(optionalString(frontmatter, "system-prompt-mode", filePath), filePath),
    body: extracted.body,
    filePath,
  };
}

export async function loadDefinitions(definitionsPath: string): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(definitionsPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw new CatalogError(definitionsPath, `cannot read definition directory: ${errorMessage(error)}`);
  }

  const definitionEntries = entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name));

  const definitions: AgentDefinition[] = [];
  const byName = new Map<string, AgentDefinition>();
  for (const entry of definitionEntries) {
    const current = await loadDefinition(resolve(definitionsPath, entry.name));
    const previous = byName.get(current.name);
    if (previous) {
      throw new CatalogError(
        current.filePath,
        `duplicate definition name '${current.name}' (already defined in ${previous.filePath})`,
      );
    }
    definitions.push(current);
    byName.set(current.name, current);
  }
  return definitions;
}
