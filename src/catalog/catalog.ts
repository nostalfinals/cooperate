import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { loadDefinitions, WILDCARD, includesEntry, type AgentDefinition, type DefinitionCatalog } from "./definitions.ts";
import { CatalogError, type CallerCatalog, type CatalogLoadOptions, type ModelRegistryLike } from "./types.ts";

function validateDefinitions(
  definitions: readonly AgentDefinition[],
  availableTools: ReadonlySet<string>,
  modelRegistry: ModelRegistryLike,
): void {
  const names = new Set(definitions.map((definition) => definition.name));
  for (const definition of definitions) {
    for (const tool of definition.tools) {
      if (tool === WILDCARD) continue;
      if (!availableTools.has(tool)) throw new CatalogError(definition.filePath, `unavailable tool '${tool}'`);
    }
    if (definition.subagentAgents.length > 0 && !includesEntry(definition.tools, "subagent")) {
      throw new CatalogError(definition.filePath, "nonempty subagents requires 'subagent' in tools");
    }
    for (const child of definition.subagentAgents) {
      if (child === WILDCARD) continue;
      if (!names.has(child)) throw new CatalogError(definition.filePath, `unknown definition '${child}' in subagents`);
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

export function formatDefinitionDiscovery(definitions: readonly { name: string; description: string }[]): string {
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
        if (!definition) throw new CatalogError(catalog.definitionsPath, `unknown allowed definition '${name}'`);
        return definition;
      });
  const definitions = selected.map(({ name, description }) => ({ name, description }));

  return {
    definitions,
    discovery: formatDefinitionDiscovery(definitions),
  };
}
