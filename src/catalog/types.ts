export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CooperateConfig {
  maxDepth: number;
  cleanOrphanSessions: boolean;
}

export interface DefinitionModel {
  provider: string;
  modelId: string;
  reference: string;
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
