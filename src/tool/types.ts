import type { CallerCatalog } from "../catalog/types.ts";
import type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "../subagent/types.ts";

export interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  wait(subagentIds: readonly string[], onSnapshot?: (snapshots: readonly SubagentSnapshot[]) => void): Promise<void>;
  cancel(subagentId: string): Promise<SubagentSnapshot | undefined>;
  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined;
  getToolDefinition?(subagentId: string, toolName: string): unknown;
}

export type SubagentToolFactory = (service: SubagentToolService, caller: CallerCatalog) => unknown;
