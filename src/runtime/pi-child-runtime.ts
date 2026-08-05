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
import { createPiContinuationHost } from "../continuation.ts";
import type { ChildInvocation, ChildRun, ChildRuntimeFactory } from "../subagent/ports.ts";
import { createSubagentDiscoveryTool } from "../tool/subagent-tool.ts";
import { modelReference, resolveInvocationSettings } from "./invocation-settings.ts";

interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): unknown;
}

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
    tools: string[];
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
      async () => { throw new Error("child Session replacement is not supported"); },
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
    throw new Error(`child active tools do not match Definition allowlist (expected: ${expected.join(", ") || "<none>"}; active: ${active.join(", ") || "<none>"})`);
  }
}

export class PiChildRuntimeFactory implements ChildRuntimeFactory {
  private readonly sdk: RuntimeSdk;

  constructor(sdk: RuntimeSdk = defaultSdk) {
    this.sdk = sdk;
  }

  async start(invocation: ChildInvocation): Promise<ChildRun> {
    const lifecycleExtension: InlineExtension = {
      name: "cooperate-structured-scope",
      hidden: true,
      factory: (pi) => {
        invocation.onContinuationHost?.(createPiContinuationHost(pi));
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
        appendSystemPromptOverride: (base) => [
          invocation.callerCatalog.discovery,
          ...base,
          invocation.definition.body,
        ],
        extensionFactories: [lifecycleExtension],
      },
    });
    const resolved = resolveInvocationSettings(
      invocation.definition,
      invocation.creatorModel,
      services.modelRuntime,
      services.settingsManager.getDefaultThinkingLevel(),
    );
    if (!invocation.record.native) throw new Error("child Session record has no native SessionManager");

    const created = await this.sdk.createSession({
      services,
      sessionManager: invocation.record.native,
      model: resolved.model,
      thinkingLevel: resolved.thinking,
      tools: [...invocation.definition.tools],
      customTools: invocation.definition.tools.includes("subagent")
        ? [(invocation.subagentTool as ToolDefinition | undefined) ?? createSubagentDiscoveryTool(invocation.callerCatalog)]
        : undefined,
    });
    const { session } = created;

    try {
      await session.bindExtensions({ mode: "print", abortHandler: () => session.abort() });
      exactTools(
        invocation.definition.tools,
        session.getAllTools().map((tool) => tool.name),
        session.getActiveToolNames(),
      );
    } catch (error) {
      await created.dispose();
      throw error;
    }

    const startIndex = session.messages.length;
    let disposed = false;
    return {
      model: invocation.definition.model?.reference ?? modelReference(resolved.model),
      thinking: resolved.thinking,
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
