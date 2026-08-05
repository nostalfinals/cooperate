import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, loadCatalog, type DefinitionCatalog } from "./catalog.ts";
import { COMPLETION_MESSAGE, createPiContinuationHost } from "./continuation.ts";
import { injectDefinitionDiscovery } from "./prompt.ts";
import { PiChildRuntimeFactory, type ChildRuntimeFactory } from "./runtime.ts";
import { NativeSessionStore, OWNERSHIP_ENTRY, ownedSessionIds } from "./sessions.ts";
import { BlockingSubagentService, createSubagentTool, isAbortedAgentEnd } from "./subagent.ts";
import { renderCompletionMessage } from "./presentation.ts";
import { SubagentsOverlay } from "./overlay.ts";
import {
  collectMasterSessionIds,
  copyMasterSessionDirectory,
  garbageCollectOrphanSessions,
  masterSessionIdFromFile,
} from "./lifecycle.ts";

export interface CooperateExtensionOptions {
  agentDir?: string;
  runtimeFactory?: ChildRuntimeFactory;
}

class SessionCatalogState {
  readonly catalog: DefinitionCatalog;
  readonly service: BlockingSubagentService;
  private disposed = false;

  constructor(catalog: DefinitionCatalog, service: BlockingSubagentService) {
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
    const continuation = createPiContinuationHost(pi);
    pi.registerMessageRenderer(COMPLETION_MESSAGE, renderCompletionMessage);
    pi.registerCommand("subagents", {
      description: "Inspect and cancel the active subagent tree",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") return;
        const service = state?.service;
        if (!service) return;
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const unsubscribe = service.subscribe(() => tui.requestRender());
          return new SubagentsOverlay({
            theme,
            snapshots: () => service.snapshotRoots(),
            cancel: (subagentId) => service.cancelFromUi(subagentId),
            close: () => done(undefined),
            requestRender: () => tui.requestRender(),
            onDispose: unsubscribe,
            startTimer: true,
          });
        });
      },
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
        const existingMasterIds = await collectMasterSessionIds(agentDir, [sessionDir]);
        if (generation !== sessionGeneration) return;
        existingMasterIds.add(masterSessionId);
        await garbageCollectOrphanSessions(agentDir, existingMasterIds);
        if (generation !== sessionGeneration) return;
      }
      const store = new NativeSessionStore({
        agentDir,
        masterSessionId,
        cwd,
      });
      const service = new BlockingSubagentService({
        catalog,
        store,
        runtimeFactory,
        agentDir,
        continuation,
        persistOwnership: async (sessionId) => {
          pi.appendEntry(OWNERSHIP_ENTRY, { sessionId });
        },
        visibleSessionIds: () => ownedSessionIds(sessionManager.getBranch()),
      });
      state = new SessionCatalogState(catalog, service);
      pi.registerTool(createSubagentTool(service, createCallerCatalog(catalog)));
    });

    pi.on("before_agent_start", (event) => {
      if (!state) return undefined;
      const discovery = createCallerCatalog(state.catalog).discovery;
      return {
        systemPrompt: injectDefinitionDiscovery(event.systemPrompt, event.systemPromptOptions, discovery),
      };
    });

    pi.on("agent_end", async (event) => {
      if (isAbortedAgentEnd(event.messages)) await state?.service.cancelActive("main agent interrupted");
      else await state?.service.waitForDescendants();
    });

    pi.on("session_before_tree", async () => {
      await state?.service.cancelActive("Session tree navigation");
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
