import type { SubagentInspection, SubagentHistoryResult } from "../subagent/messages.ts";
import type { CallerCatalog } from "../catalog/types.ts";
import type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "../subagent/types.ts";

export interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(all?: boolean): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  inspectSubagent(subagentId: string): SubagentInspection;
  historyMessages(subagentId: string, options?: { offset?: number; limit?: number; messageId?: string }): Promise<SubagentHistoryResult>;
  steer(subagentId: string, text: string): Promise<void>;
  cancel(subagentId: string): Promise<SubagentSnapshot | undefined>;
  snapshotOrLast(subagentId: string): SubagentSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  getToolDefinition?(subagentId: string, toolName: string): unknown;
}

export type SubagentToolFactory = (service: SubagentToolService, caller: CallerCatalog) => unknown;
