import type { AgentDefinition, CallerCatalog } from "../catalog/types.ts";
import type { ContinuationHost } from "../continuation.ts";
import type {
  RunEnvironment,
  RunRequest,
  RunResponse,
  SubagentSnapshot,
  TerminalCause,
} from "./types.ts";

export interface SessionRecord {
  sessionId: string;
  file: string;
  native?: unknown;
}

export interface SessionInspection {
  task: string;
  result: string;
}

export interface SessionStore {
  create(): Promise<SessionRecord>;
  open(sessionId: string): Promise<SessionRecord>;
  list(): Promise<readonly SessionRecord[]>;
  inspect(record: SessionRecord): Promise<SessionInspection>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChildInvocation {
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

export interface ChildRun {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  prompt(task: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  messagesSinceStart(): readonly unknown[];
}

export interface ChildRuntimeFactory {
  start(invocation: ChildInvocation): Promise<ChildRun>;
}

export interface SubagentToolService {
  run(request: RunRequest, environment: RunEnvironment): Promise<RunResponse>;
  listSubagents(): readonly Record<string, unknown>[];
  listSessions(): Promise<readonly Record<string, unknown>[]>;
  wait(subagentIds: readonly string[]): Promise<void>;
  cancel(subagentId: string): Promise<void>;
}

export type SubagentToolFactory = (service: SubagentToolService, caller: CallerCatalog) => unknown;

export type { RunEnvironment, RunRequest, RunResponse, SubagentSnapshot } from "./types.ts";
