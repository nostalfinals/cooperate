import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { loadCatalog, type DefinitionCatalog } from "./catalog.ts";

export interface CooperateExtensionOptions {
  agentDir?: string;
}

class SessionCatalogState {
  readonly catalog: DefinitionCatalog;
  private disposed = false;

  constructor(catalog: DefinitionCatalog) {
    this.catalog = catalog;
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
  }
}

export function createCooperateExtension(options: CooperateExtensionOptions = {}): ExtensionFactory {
  const agentDir = options.agentDir ?? getAgentDir();

  return (pi: ExtensionAPI) => {
    let state: SessionCatalogState | undefined;

    pi.on("session_start", async (_event, ctx) => {
      await state?.shutdown();
      state = undefined;

      const catalog = await loadCatalog({
        agentDir,
        availableTools: pi.getAllTools().map((tool) => tool.name),
        modelRegistry: ctx.modelRegistry,
      });
      state = new SessionCatalogState(catalog);
    });

    pi.on("session_shutdown", async () => {
      const current = state;
      state = undefined;
      await current?.shutdown();
    });
  };
}

export default createCooperateExtension();
