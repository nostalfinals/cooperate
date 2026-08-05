import { CatalogError, type CallerCatalog, type DefinitionCatalog } from "./types.ts";

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
        if (!definition) throw new CatalogError(catalog.definitionsPath, `unknown allowed Definition '${name}'`);
        return definition;
      });
  const definitions = selected.map(({ name, description }) => ({ name, description }));

  return {
    definitions,
    discovery: formatDefinitionDiscovery(definitions),
  };
}
