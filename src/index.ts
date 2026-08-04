import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, loadCatalog, type DefinitionCatalog } from "./catalog.ts";
import { PiChildRuntimeFactory, type ChildRuntimeFactory } from "./runtime.ts";
import { NativeSessionStore, OWNERSHIP_ENTRY, ownedSessionIds } from "./sessions.ts";
import { BlockingSubagentService, createSubagentTool } from "./subagent.ts";

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

    pi.on("session_start", async (_event, ctx) => {
      await state?.shutdown();
      state = undefined;

      const catalog = await loadCatalog({
        agentDir,
        availableTools: new Set([...pi.getAllTools().map((tool) => tool.name), "subagent"]),
        modelRegistry: ctx.modelRegistry,
      });
      const store = new NativeSessionStore({
        agentDir,
        masterSessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
      });
      const service = new BlockingSubagentService({
        catalog,
        store,
        runtimeFactory,
        agentDir,
        persistOwnership: async (sessionId) => {
          pi.appendEntry(OWNERSHIP_ENTRY, { sessionId });
        },
        visibleSessionIds: () => ownedSessionIds(ctx.sessionManager.getBranch()),
      });
      state = new SessionCatalogState(catalog, service);
      pi.registerTool(createSubagentTool(service, createCallerCatalog(catalog)));
    });

    pi.on("session_shutdown", async () => {
      const current = state;
      state = undefined;
      await current?.shutdown();
    });
  };
}

export default createCooperateExtension();
