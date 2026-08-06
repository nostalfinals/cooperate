export interface RunRequest {
  agent: string;
  task: string;
  prompt: string;
  sessionId?: string;
  async?: boolean;
}

export interface RunEnvironment {
  cwd: string;
  creatorModel: unknown;
  signal?: AbortSignal;
  toolCallId?: string;
  onSnapshot?(snapshot: SubagentSnapshot): void;
}

export interface RunResponse {
  sessionId: string;
  result: string;
  subagentId?: string;
}

export type ActiveSubagentState = "running" | "waiting";
export type TerminalSubagentState = "finished" | "failed" | "cancelled";

export interface SubagentActivity {
  toolName: string;
  input: Record<string, unknown>;
}

export interface TerminalCause {
  state: TerminalSubagentState;
  reason?: string;
}

export interface SubagentSnapshot {
  readonly subagentId: string;
  readonly parentId?: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly task: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly depth: number;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly state: ActiveSubagentState | TerminalSubagentState;
  readonly reason?: string;
  readonly activity?: SubagentActivity;
  readonly children: readonly SubagentSnapshot[];
}

export interface StartNode {
  parentId?: string;
  sessionId: string;
  agent: string;
  task: string;
}

export interface StartedNode {
  subagentId: string;
  depth: number;
}

export function isActive(snapshot: SubagentSnapshot): boolean {
  return snapshot.state === "running" || snapshot.state === "waiting";
}
