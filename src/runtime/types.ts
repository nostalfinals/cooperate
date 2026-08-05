import type { AgentDefinition } from "../catalog/definitions.ts";
import type { CallerCatalog, ThinkingLevel } from "../catalog/types.ts";
import type { Messenger } from "../subagent/messenger.ts";
import type { SubagentActivity } from "../subagent/types.ts";
import type { SessionRecord } from "../session/types.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  onMessenger?(messenger: Messenger): void;
  onAgentEnd?(cause: TerminalCause): Promise<void>;
  onActivity?(activity: SubagentActivity): void;
}

export interface SubagentRun {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  prompt(task: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  messagesSinceStart(): readonly unknown[];
  getToolDefinition?(toolName: string): ToolDefinition | undefined;
}

export interface ChildRuntimeFactory {
  start(invocation: SubagentInvocation): Promise<SubagentRun>;
}

export type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "../subagent/types.ts";
