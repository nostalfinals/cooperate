import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { parseDocument } from "yaml";

export const DEFAULT_CONFIG = Object.freeze({
  maxDepth: 3,
  gcOrphanSessions: true,
});

const CONFIG_FIELDS = new Set(["maxDepth", "gcOrphanSessions"]);
const DEFINITION_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "subagent_agents",
  "model",
  "thinking",
]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CooperateConfig {
  maxDepth: number;
  gcOrphanSessions: boolean;
}

export interface DefinitionModel {
  provider: string;
  modelId: string;
  reference: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: readonly string[];
  subagentAgents: readonly string[];
  model?: DefinitionModel;
  thinking?: ThinkingLevel;
  body: string;
  filePath: string;
}

export interface DefinitionCatalog {
  config: CooperateConfig;
  definitions: readonly AgentDefinition[];
  configPath: string;
  definitionsPath: string;
}

export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
}

export interface CatalogLoadOptions {
  agentDir: string;
  availableTools: Iterable<string>;
  modelRegistry: ModelRegistryLike;
}

export interface CallerDefinition {
  name: string;
  description: string;
}

export interface CallerCatalog {
  definitions: readonly CallerDefinition[];
  discovery: string;
  agentSchema: TSchema;
}

export class CatalogError extends Error {
  readonly sourcePath: string;
  readonly reason: string;

  constructor(sourcePath: string, reason: string) {
    super(`${sourcePath}: ${reason}`);
    this.name = "CatalogError";
    this.sourcePath = sourcePath;
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadConfig(configPath: string): Promise<CooperateConfig> {
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

  const gcOrphanSessions = Object.hasOwn(value, "gcOrphanSessions")
    ? value.gcOrphanSessions
    : DEFAULT_CONFIG.gcOrphanSessions;
  if (typeof gcOrphanSessions !== "boolean") {
    throw new CatalogError(configPath, "gcOrphanSessions must be a boolean");
  }

  return { maxDepth: maxDepth as number, gcOrphanSessions };
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
    throw new CatalogError(filePath, `malformed YAML: ${document.errors[0].message}`);
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
  return entries;
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

async function loadDefinition(filePath: string): Promise<AgentDefinition> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CatalogError(filePath, `cannot read Definition: ${errorMessage(error)}`);
  }

  const extracted = extractFrontmatter(source, filePath);
  const frontmatter = parseFrontmatter(extracted.yaml, filePath);
  for (const field of Object.keys(frontmatter)) {
    if (!DEFINITION_FIELDS.has(field)) {
      throw new CatalogError(filePath, `unknown frontmatter field '${field}'`);
    }
  }

  const name = requiredString(frontmatter, "name", filePath);
  if (!NAME_PATTERN.test(name)) throw new CatalogError(filePath, "name must match ^[A-Za-z0-9_-]+$");
  const description = requiredString(frontmatter, "description", filePath);
  if (extracted.body.trim().length === 0) throw new CatalogError(filePath, "Markdown body must be nonempty");

  return {
    name,
    description,
    tools: commaSeparatedList(frontmatter, "tools", filePath),
    subagentAgents: commaSeparatedList(frontmatter, "subagent_agents", filePath),
    model: parseModel(optionalString(frontmatter, "model", filePath), filePath),
    thinking: parseThinking(optionalString(frontmatter, "thinking", filePath), filePath),
    body: extracted.body,
    filePath,
  };
}

async function loadDefinitions(definitionsPath: string): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(definitionsPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw new CatalogError(definitionsPath, `cannot read Definition directory: ${errorMessage(error)}`);
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
        `duplicate Definition name '${current.name}' (already defined in ${previous.filePath})`,
      );
    }
    definitions.push(current);
    byName.set(current.name, current);
  }
  return definitions;
}

function validateDefinitions(
  definitions: readonly AgentDefinition[],
  availableTools: ReadonlySet<string>,
  modelRegistry: ModelRegistryLike,
): void {
  const names = new Set(definitions.map((definition) => definition.name));
  for (const definition of definitions) {
    for (const tool of definition.tools) {
      if (!availableTools.has(tool)) throw new CatalogError(definition.filePath, `unavailable tool '${tool}'`);
    }
    if (definition.subagentAgents.length > 0 && !definition.tools.includes("subagent")) {
      throw new CatalogError(definition.filePath, "nonempty subagent_agents requires 'subagent' in tools");
    }
    for (const child of definition.subagentAgents) {
      if (!names.has(child)) throw new CatalogError(definition.filePath, `unknown Definition '${child}' in subagent_agents`);
    }
    if (definition.model && !modelRegistry.find(definition.model.provider, definition.model.modelId)) {
      throw new CatalogError(
        definition.filePath,
        `model '${definition.model.reference}' is absent from Pi's registry`,
      );
    }
  }
}

export async function loadCatalog(options: CatalogLoadOptions): Promise<DefinitionCatalog> {
  const cooperatePath = resolve(options.agentDir, "cooperate");
  const configPath = resolve(cooperatePath, "config.json");
  const definitionsPath = resolve(cooperatePath, "subagents");

  const config = await loadConfig(configPath);
  const definitions = await loadDefinitions(definitionsPath);
  validateDefinitions(definitions, new Set(options.availableTools), options.modelRegistry);

  return { config, definitions, configPath, definitionsPath };
}

export function formatDefinitionDiscovery(definitions: readonly CallerDefinition[]): string {
  if (definitions.length === 0) return "No subagent is defined yet";
  return `Available subagent definitions:\n\n${definitions.map((item) => `- ${item.name}: ${item.description}`).join("\n")}`;
}

export function createCallerCatalog(
  catalog: DefinitionCatalog,
  allowedNames?: readonly string[],
): CallerCatalog {
  const byName = new Map(catalog.definitions.map((definition) => [definition.name, definition]));
  const selected = allowedNames === undefined
    ? [...catalog.definitions]
    : allowedNames.map((name) => {
        const definition = byName.get(name);
        if (!definition) throw new CatalogError(catalog.definitionsPath, `unknown allowed Definition '${name}'`);
        return definition;
      });
  const definitions = selected.map(({ name, description }) => ({ name, description }));
  const names = definitions.map((definition) => definition.name);

  return {
    definitions,
    discovery: formatDefinitionDiscovery(definitions),
    agentSchema: StringEnum(names, { description: "Definition name available to this caller" }),
  };
}
