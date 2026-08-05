import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "../catalog/types.ts";

interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): unknown;
}

export function resolveInvocationSettings(
  definition: AgentDefinition,
  creatorModel: unknown,
  modelRuntime: ModelRuntimeLike,
  defaultThinking: ThinkingLevel | undefined,
): { model: unknown; thinking: ThinkingLevel } {
  let model: unknown;
  if (definition.model) {
    model = modelRuntime.getModel(definition.model.provider, definition.model.modelId);
    if (!model) throw new Error(`Definition model '${definition.model.reference}' is unavailable at invocation time`);
  } else {
    model = creatorModel;
    if (!model) throw new Error("creator has no current model");
  }
  return {
    model,
    thinking: definition.thinking ?? defaultThinking ?? "medium",
  };
}

export function modelReference(model: unknown): string {
  if (typeof model !== "object" || model === null) return String(model ?? "unknown");
  const value = model as { provider?: unknown; id?: unknown; modelId?: unknown };
  const id = typeof value.id === "string" ? value.id : typeof value.modelId === "string" ? value.modelId : undefined;
  return typeof value.provider === "string" && id ? `${value.provider}/${id}` : id ?? "unknown";
}
