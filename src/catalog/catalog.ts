import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { loadDefinitions } from "./definitions.ts";
import { CatalogError, type AgentDefinition, type CatalogLoadOptions, type DefinitionCatalog, type ModelRegistryLike } from "./types.ts";

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
