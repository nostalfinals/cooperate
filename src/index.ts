import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, loadCatalog } from "./catalog/catalog.ts";
import type { DefinitionCatalog } from "./catalog/definitions.ts";
import { COMPLETION_MESSAGE, createCompletionMessenger } from "./subagent/messenger.ts";
import { injectDefinitionDiscovery } from "./prompt.ts";
import { PiChildRuntimeFactory } from "./runtime/runtime.ts";
import type { ChildRuntimeFactory } from "./runtime/types.ts";
import { isAbortedAgentEnd } from "./subagent/result.ts";
import { SubagentService } from "./subagent/service.ts";
import { NativeSessionStore } from "./session/native-store.ts";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "./session/ownership.ts";
import { createSubagentTool } from "./tool/subagent-tool.ts";
import { setToolDefinitionProvider } from "./tool/activity-title.ts";
import { renderCompletionMessage } from "./ui/presentation.ts";
import { SubagentsPanel } from "./ui/panel/subagents-panel.ts";
import { copyMasterSessionDirectory, masterSessionIdFromFile } from "./session/master-copy.ts";
import { collectMasterSessionIds, garbageCollectOrphanSessions } from "./session/orphan-gc.ts";

export interface CooperateExtensionOptions {
  agentDir?: string;
  runtimeFactory?: ChildRuntimeFactory;
}

class SessionCatalogState {
  readonly catalog: DefinitionCatalog;
  readonly service: SubagentService;
  private disposed = false;

  constructor(catalog: DefinitionCatalog, service: SubagentService) {
    this.catalog = catalog;
    this.service = service;
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.service.shutdown();
  }
}

export function createCooperateExtension(options: CooperateExtensionOptions = {}): ExtensionFactory {
  const agentDir = options.agentDir ?? getAgentDir();
  const runtimeFactory = options.runtimeFactory ?? new PiChildRuntimeFactory();

  return (pi: ExtensionAPI) => {
    let state: SessionCatalogState | undefined;
    let sessionGeneration = 0;
    const messenger = createCompletionMessenger(pi);
    const runOrphanSessionGc = async (options: {
      agentDir: string;
      sessionDir: string;
      masterSessionId: string;
      generation: number;
    }): Promise<void> => {
      try {
        const existingMasterIds = await collectMasterSessionIds(options.agentDir, [options.sessionDir]);
        if (options.generation !== sessionGeneration) return;
        existingMasterIds.add(options.masterSessionId);
        await garbageCollectOrphanSessions(options.agentDir, existingMasterIds, {
          // Drop stale runs before they delete anything: session replacement
          // bumps sessionGeneration, and the synchronous per-path check cannot
          // race a fork copy that creates a fresh namespace.
          shouldProceed: () => options.generation === sessionGeneration,
        });
      } catch (error) {
        // Orphan GC is best-effort housekeeping; never fail session startup.
        console.error("[cooperate] orphan session GC failed:", error);
      }
    };
    pi.registerMessageRenderer(COMPLETION_MESSAGE, renderCompletionMessage);
    pi.registerTool(createSubagentTool({
      service: () => state?.service,
      caller: () => (state ? createCallerCatalog(state.catalog) : undefined),
    }));
    setToolDefinitionProvider((subagentId, toolName) => state?.service?.getToolDefinition(subagentId, toolName));
    pi.registerCommand("subagents", {
      description: "Inspect and cancel the active subagent tree",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") return;
        const service = state?.service;
        if (!service) return;
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const unsubscribe = service.subscribe(() => tui.requestRender());
          return new SubagentsPanel({
            theme,
            snapshots: () => service.snapshotRoots(),
            snapshotOf: (subagentId) => service.snapshotOf(subagentId),
            cancel: (subagentId) => service.cancelFromUi(subagentId),
            steer: (subagentId, text) => service.steer(subagentId, text),
            replaceSteering: (subagentId, text) => service.replaceSteering(subagentId, text),
            getSteeringMessages: (subagentId) => service.getSteeringMessages(subagentId),
            getTree: (subagentId) => service.getTree(subagentId),
            close: () => done(undefined),
            requestRender: () => tui.requestRender(),
            onDispose: unsubscribe,
            startTimer: true,
            terminalRows: tui.terminal.rows,
          });
        });
      },
    });

    pi.on("input", (event) => {
      // Only a user prompt starts a new round; wake-ups from subagent completion
      // messages must keep the finished subagents visible in /subagents.
      if (event.source === "interactive") state?.service?.clearCompleted();
    });

    pi.on("session_start", async (event, ctx) => {
      const generation = ++sessionGeneration;
      const previousState = state;
      state = undefined;

      // Snapshot session-bound values before yielding. Session replacement may
      // invalidate ctx while catalog loading, namespace copying, or GC is pending.
      const availableTools = new Set([...pi.getAllTools().map((tool) => tool.name), "subagent"]);
      const modelRegistry = ctx.modelRegistry;
      const sessionManager = ctx.sessionManager;
      const masterSessionId = sessionManager.getSessionId();
      const sessionDir = sessionManager.getSessionDir();
      const cwd = ctx.cwd;

      await previousState?.shutdown();
      if (generation !== sessionGeneration) return;

      const catalog = await loadCatalog({ agentDir, availableTools, modelRegistry });
      if (generation !== sessionGeneration) return;

      if (event.reason === "fork" && event.previousSessionFile) {
        await copyMasterSessionDirectory(
          agentDir,
          masterSessionIdFromFile(event.previousSessionFile),
          masterSessionId,
        );
        if (generation !== sessionGeneration) return;
      }
      if (catalog.config.gcOrphanSessions) {
        // Best-effort housekeeping: run in the background so session startup
        // (and the "New session started" indicator) is not delayed by scanning
        // Pi's session store. Nothing in the new session depends on its result.
        void runOrphanSessionGc({ agentDir, sessionDir, masterSessionId, generation });
      }
      const store = new NativeSessionStore({
        agentDir,
        masterSessionId,
        cwd,
      });
      const service = new SubagentService({
        catalog,
        store,
        runtimeFactory,
        toolFactory: createSubagentTool,
        agentDir,
        messenger,
        persistOwnership: async (sessionId) => {
          pi.appendEntry(OWNERSHIP_ENTRY, { sessionId });
        },
        visibleSessionIds: () => ownedSessionIds(sessionManager.getBranch()),
      });
      state = new SessionCatalogState(catalog, service);
    });

    pi.on("before_agent_start", (event) => {
      if (!state) return undefined;
      const discovery = createCallerCatalog(state.catalog).discovery;
      return {
        systemPrompt: injectDefinitionDiscovery(event.systemPrompt, event.systemPromptOptions, discovery),
      };
    });

    pi.on("agent_end", async (event, ctx) => {
      const service = state?.service;
      if (!service) return;
      const reason = "main agent interrupted";
      if (isAbortedAgentEnd(event.messages) || ctx.signal?.aborted) {
        await service.cancelActive(reason);
        return;
      }
      const signal = ctx.signal;
      let interrupted = false;
      const onAbort = () => { interrupted = true; };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([
          service.waitForDescendants(),
          new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (interrupted) await service.cancelActive(reason);
    });

    pi.on("session_before_tree", async () => {
      await state?.service.cancelActive("session tree navigation");
    });

    pi.on("session_shutdown", async () => {
      sessionGeneration++;
      const current = state;
      state = undefined;
      await current?.shutdown();
    });
  };
}

export default createCooperateExtension();
