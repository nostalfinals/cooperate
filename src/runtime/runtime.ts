import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSessionServices,
  type InlineExtension,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createPiContinuationHost } from "../subagent/continuation.ts";
import { subagentRoleBlock } from "../prompt.ts";
import { includesEntry, isWildcard, type AgentDefinition } from "../catalog/definitions.ts";
import { createSubagentDiscoveryTool } from "../tool/subagent-tool.ts";
import type { ChildRuntimeFactory, ModelRuntimeLike, SubagentInvocation, SubagentRun } from "./types.ts";

interface SettingsManagerLike {
  getDefaultThinkingLevel(): ThinkingLevel | undefined;
}

interface ServicesLike {
  modelRuntime: ModelRuntimeLike;
  settingsManager: SettingsManagerLike;
}

interface SessionLike {
  readonly messages: unknown[];
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
  bindExtensions(bindings: { mode: "print"; abortHandler: () => void }): Promise<void>;
  prompt(task: string): Promise<void>;
  abort(): void;
  dispose(): void;
}

interface RuntimeSdk {
  createServices(options: {
    cwd: string;
    agentDir?: string;
    resourceLoaderOptions: {
      appendSystemPromptOverride: (base: string[]) => string[];
      extensionFactories?: InlineExtension[];
    };
  }): Promise<ServicesLike>;
  createSession(options: {
    services: ServicesLike;
    sessionManager: unknown;
    model: unknown;
    thinkingLevel: ThinkingLevel;
    tools?: string[];
    customTools?: ToolDefinition[];
  }): Promise<{ session: SessionLike; dispose(): Promise<void> }>;
}

const defaultSdk: RuntimeSdk = {
  createServices: (options) => createAgentSessionServices(options) as Promise<AgentSessionServices>,
  createSession: async (options) => {
    const services = options.services as AgentSessionServices;
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager as SessionManager,
      model: options.model as Model<any>,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools,
      customTools: options.customTools,
    });
    const runtime = new AgentSessionRuntime(
      result.session,
      services,
      async () => { throw new Error("child session replacement is not supported"); },
      services.diagnostics,
      result.modelFallbackMessage,
    );
    return {
      session: result.session as unknown as SessionLike,
      dispose: () => runtime.dispose(),
    };
  },
};

function terminalFailure(messages: readonly unknown[], startIndex: number): string | undefined {
  for (let index = messages.length - 1; index >= startIndex; index--) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") continue;
    const stopReason = "stopReason" in message ? message.stopReason : undefined;
    if (stopReason !== "error" && stopReason !== "aborted") return undefined;
    if ("errorMessage" in message && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      return message.errorMessage;
    }
    return stopReason === "aborted" ? "cancelled" : "child model run failed";
  }
  return undefined;
}

function exactTools(expected: readonly string[], available: readonly string[], active: readonly string[]): void {
  const availableSet = new Set(available);
  for (const tool of expected) {
    if (!availableSet.has(tool)) throw new Error(`unavailable configured tool '${tool}'`);
  }
  const expectedSet = new Set(expected);
  if (active.length !== expectedSet.size || active.some((tool) => !expectedSet.has(tool))) {
    throw new Error(`child active tools do not match definition allowlist (expected: ${expected.join(", ") || "<none>"}; active: ${active.join(", ") || "<none>"})`);
  }
}

export function resolveSubagentModelConfig(
  definition: AgentDefinition,
  creatorModel: unknown,
  modelRuntime: ModelRuntimeLike,
  defaultThinking: ThinkingLevel | undefined,
): { model: unknown; thinking: ThinkingLevel } {
  let model: unknown;
  if (definition.model) {
    model = modelRuntime.getModel(definition.model.provider, definition.model.modelId);
    if (!model) throw new Error(`Model ${definition.model.reference} for subagent ${definition.name} is unavailable at invocation time`);
  } else {
    model = creatorModel;
    if (!model) throw new Error("Unable to inherit model from subagent creator: creator has no model configured");
  }
  return {
    model,
    thinking: definition.thinking ?? defaultThinking ?? "medium",
  };
}

function modelReference(model: unknown): string {
  if (typeof model !== "object" || model === null) return String(model ?? "unknown");
  const value = model as { provider?: unknown; id?: unknown; modelId?: unknown };
  const id = typeof value.id === "string" ? value.id : typeof value.modelId === "string" ? value.modelId : undefined;
  return typeof value.provider === "string" && id ? `${value.provider}/${id}` : id ?? "unknown";
}

export class PiChildRuntimeFactory implements ChildRuntimeFactory {
  private readonly sdk: RuntimeSdk;

  constructor(sdk: RuntimeSdk = defaultSdk) {
    this.sdk = sdk;
  }

  async start(invocation: SubagentInvocation): Promise<SubagentRun> {
    const systemPromptMode = invocation.definition.systemPromptMode ?? "append";
    const roleBlock = systemPromptMode === "append" ? subagentRoleBlock(invocation.definition.body) : undefined;
    const lifecycleExtension: InlineExtension = {
      name: "cooperate-structured-scope",
      hidden: true,
      factory: (pi) => {
        invocation.onContinuationHost?.(createPiContinuationHost(pi));
        if (systemPromptMode === "override") {
          pi.on("before_agent_start", () => ({ systemPrompt: invocation.definition.body }));
        }
        pi.on("agent_end", async (event) => {
          if (!invocation.onAgentEnd) return;
          const failure = terminalFailure(event.messages, 0);
          await invocation.onAgentEnd(failure
            ? { state: failure === "cancelled" ? "cancelled" : "failed", reason: failure }
            : { state: "finished" });
        });
      },
    };
    const services = await this.sdk.createServices({
      cwd: invocation.cwd,
      agentDir: invocation.agentDir,
      resourceLoaderOptions: {
        appendSystemPromptOverride: (base) => systemPromptMode === "override"
          ? base
          : [
              invocation.callerCatalog.discovery,
              ...base,
              ...(roleBlock ? [roleBlock] : []),
            ],
        extensionFactories: [lifecycleExtension],
      },
    });
    const modelConfig = resolveSubagentModelConfig(
      invocation.definition,
      invocation.creatorModel,
      services.modelRuntime,
      services.settingsManager.getDefaultThinkingLevel(),
    );
    if (!invocation.record.native) throw new Error("child session record has no native SessionManager");

    const allTools = isWildcard(invocation.definition.tools);
    const created = await this.sdk.createSession({
      services,
      sessionManager: invocation.record.native,
      model: modelConfig.model,
      thinkingLevel: modelConfig.thinking,
      tools: allTools ? undefined : [...invocation.definition.tools],
      customTools: includesEntry(invocation.definition.tools, "subagent")
        ? [(invocation.subagentTool as ToolDefinition | undefined) ?? createSubagentDiscoveryTool(invocation.callerCatalog)]
        : undefined,
    });
    const { session } = created;

    try {
      await session.bindExtensions({ mode: "print", abortHandler: () => session.abort() });
      const availableTools = session.getAllTools().map((tool) => tool.name);
      if (allTools) {
        // A wildcard definition activates every tool available to the child runtime.
        session.setActiveToolsByName(availableTools);
      }
      exactTools(
        allTools ? availableTools : invocation.definition.tools,
        availableTools,
        session.getActiveToolNames(),
      );
    } catch (error) {
      await created.dispose();
      throw error;
    }

    const startIndex = session.messages.length;
    let disposed = false;
    return {
      model: invocation.definition.model?.reference ?? modelReference(modelConfig.model),
      thinking: modelConfig.thinking,
      prompt: async (task) => {
        await session.prompt(task);
        const failure = terminalFailure(session.messages, startIndex);
        if (failure) throw new Error(failure);
      },
      abort: () => session.abort(),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await created.dispose();
      },
      messagesSinceStart: () => session.messages.slice(startIndex),
    };
  }
}
