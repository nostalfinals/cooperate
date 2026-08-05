import type { CallerCatalog } from "../catalog/types.ts";
import type { RunEnvironment, RunRequest, RunResponse } from "../subagent/types.ts";

export interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  wait(subagentIds: readonly string[]): Promise<void>;
  cancel(subagentId: string): Promise<void>;
}

export type SubagentToolFactory = (service: SubagentToolService, caller: CallerCatalog) => unknown;
