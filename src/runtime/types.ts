import type { AgentDefinition } from "../catalog/definitions.ts";
import type { CallerCatalog, ThinkingLevel } from "../catalog/types.ts";
import type { ContinuationHost } from "../continuation.ts";
import type { SessionRecord } from "../session/types.ts";
import type {
  RunEnvironment,
  RunRequest,
  RunResponse,
  SubagentSnapshot,
  TerminalCause,
} from "../subagent/types.ts";

/** Pi model-registry shape the child runtime needs at invocation time. */
export interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): unknown;
}

export interface SubagentInvocation {
  cwd: string;
  agentDir?: string;
  definition: AgentDefinition;
  callerCatalog: CallerCatalog;
  record: SessionRecord;
  creatorModel: unknown;
  task: string;
  subagentTool?: unknown;
  onContinuationHost?(host: ContinuationHost): void;
  onAgentEnd?(cause: TerminalCause): Promise<void>;
}

export interface SubagentRun {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  prompt(task: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  messagesSinceStart(): readonly unknown[];
}

export interface ChildRuntimeFactory {
  start(invocation: SubagentInvocation): Promise<SubagentRun>;
}

export type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "../subagent/types.ts";
