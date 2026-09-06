import type { CallerCatalog } from "../catalog/types.ts";
import type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "../subagent/types.ts";

export interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(all?: boolean): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  inspectSubagent(subagentId: string): Record<string, unknown>;
  historyMessages(subagentId: string, options?: { offset?: number; limit?: number; messageId?: string }): Promise<Record<string, unknown>>;
  steer(subagentId: string, text: string): Promise<void>;
  cancel(subagentId: string): Promise<SubagentSnapshot | undefined>;
  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined;
  getToolDefinition?(subagentId: string, toolName: string): unknown;
}

export type SubagentToolFactory = (service: SubagentToolService, caller: CallerCatalog) => unknown;
