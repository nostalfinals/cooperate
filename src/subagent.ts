import { randomBytes } from "node:crypto";
import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, CallerCatalog, DefinitionCatalog } from "./catalog.ts";
import type { ChildRun, ChildRuntimeFactory } from "./runtime.ts";
import type { SessionRecord, SessionStore } from "./sessions.ts";
import { compactPreview, truncateForTool } from "./sessions.ts";

export interface RunRequest {
  agent: string;
  task: string;
  sessionId?: string;
  async?: boolean;
}

export interface RunEnvironment {
  cwd: string;
  creatorModel: unknown;
  signal?: AbortSignal;
}

export interface BlockingSubagentOptions {
  catalog: DefinitionCatalog;
  store: SessionStore;
  runtimeFactory: ChildRuntimeFactory;
  persistOwnership(sessionId: string): Promise<void>;
  visibleSessionIds(): readonly string[];
  agentDir?: string;
}

interface ActiveBinding {
  subagentId: string;
  agent: string;
  sessionId: string;
  task: string;
  startedAt: number;
  run?: ChildRun;
  abortRequested: boolean;
  settled: Promise<void>;
  resolveSettled(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractFinalText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text;
      }
    }
    return "<none>";
  }
  return "<none>";
}

function generateId(active: ReadonlyMap<string, ActiveBinding>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!active.has(id)) return id;
  }
}

export class BlockingSubagentService {
  private readonly options: BlockingSubagentOptions;
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;
  private readonly locks = new Set<string>();
  private readonly active = new Map<string, ActiveBinding>();
  private disposed = false;

  constructor(options: BlockingSubagentOptions) {
    this.options = options;
    this.definitions = new Map(options.catalog.definitions.map((definition) => [definition.name, definition]));
  }

  async run(request: RunRequest, environment: RunEnvironment): Promise<{ sessionId: string; result: string }> {
    if (this.disposed) throw new Error("subagent runtime is shutting down");
    if (request.async) throw new Error("asynchronous subagents are not implemented in this slice");
    const definition = this.definitions.get(request.agent);
    if (!definition) throw new Error(`Definition '${request.agent}' is not available to this caller`);
    if (request.task.trim().length === 0) throw new Error("task must be nonempty");

    let record: SessionRecord;
    if (request.sessionId) {
      if (!this.options.visibleSessionIds().includes(request.sessionId)) {
        throw new Error(`Session '${request.sessionId}' is not a direct branch-visible child`);
      }
      if (this.locks.has(request.sessionId)) throw new Error(`Session '${request.sessionId}' is locked`);
      record = await this.options.store.open(request.sessionId);
    } else {
      record = await this.options.store.create();
      await this.options.persistOwnership(record.sessionId);
    }

    if (this.locks.has(record.sessionId)) throw new Error(`Session '${record.sessionId}' is locked`);
    this.locks.add(record.sessionId);
    const subagentId = generateId(this.active);
    let resolveSettled!: () => void;
    const binding: ActiveBinding = {
      subagentId,
      agent: definition.name,
      sessionId: record.sessionId,
      task: request.task,
      startedAt: Date.now(),
      abortRequested: false,
      settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
      resolveSettled: () => resolveSettled(),
    };
    this.active.set(subagentId, binding);

    let run: ChildRun | undefined;
    let abort: (() => void) | undefined;
    try {
      run = await this.options.runtimeFactory.start({
        cwd: environment.cwd,
        agentDir: this.options.agentDir,
        definition,
        record,
        creatorModel: environment.creatorModel,
        task: request.task,
      });
      const currentRun = run;
      binding.run = currentRun;
      abort = () => currentRun.abort();
      if (binding.abortRequested || environment.signal?.aborted) abort();
      environment.signal?.addEventListener("abort", abort, { once: true });
      await run.prompt(request.task);
      return {
        sessionId: record.sessionId,
        result: truncateForTool(extractFinalText(run.messagesSinceStart())),
      };
    } catch (error) {
      throw new Error(`Session ${record.sessionId}: ${errorMessage(error)}`, { cause: error });
    } finally {
      if (abort) environment.signal?.removeEventListener("abort", abort);
      try {
        await run?.dispose();
      } finally {
        this.active.delete(subagentId);
        this.locks.delete(record.sessionId);
        binding.resolveSettled();
      }
    }
  }

  listSubagents(): readonly Record<string, unknown>[] {
    const now = Date.now();
    return [...this.active.values()].map((binding) => ({
      subagentId: binding.subagentId,
      agent: binding.agent,
      session: binding.sessionId,
      task: compactPreview(binding.task),
      state: "running",
      elapsedMs: now - binding.startedAt,
    }));
  }

  async listSessions(): Promise<readonly Record<string, unknown>[]> {
    const visible = new Set(this.options.visibleSessionIds());
    const records = (await this.options.store.list()).filter((record) => visible.has(record.sessionId));
    return Promise.all(records.map(async (record) => {
      const inspection = await this.options.store.inspect(record);
      return {
        session: record.sessionId,
        locked: this.locks.has(record.sessionId),
        task: inspection.task,
        result: inspection.result,
        file: record.file,
      };
    }));
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const bindings = [...this.active.values()];
    for (const binding of bindings) {
      binding.abortRequested = true;
      binding.run?.abort();
    }
    await Promise.all(bindings.map((binding) => binding.settled));
  }
}

const actionSchema = (agentSchema: TSchema) => Type.Union([
  Type.Object({
    action: Type.Literal("run"),
    agent: agentSchema,
    task: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(Type.String()),
    async: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list-subagents") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list-sessions") }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("wait"),
    subagentIds: Type.Array(Type.String({ pattern: "^[0-9a-f]{8}$" }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("cancel"),
    subagentId: Type.String({ pattern: "^[0-9a-f]{8}$" }),
  }, { additionalProperties: false }),
]);

function textResult(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: truncateForTool(value) }], details: undefined };
}

export function createSubagentTool(
  service: BlockingSubagentService,
  caller: CallerCatalog,
): ToolDefinition {
  return {
    name: "subagent",
    label: "subagent",
    description: `Run and manage direct configured subagents.\n\n${caller.description}`,
    parameters: actionSchema(caller.agentSchema),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const action = (params as { action: string }).action;
      if (action === "run") {
        const request = params as unknown as RunRequest;
        const result = await service.run(request, { cwd: ctx.cwd, creatorModel: ctx.model, signal });
        return textResult(result.result);
      }
      if (action === "list-subagents") return textResult(JSON.stringify(service.listSubagents(), null, 2));
      if (action === "list-sessions") return textResult(JSON.stringify(await service.listSessions(), null, 2));
      throw new Error(`subagent action '${action}' is not implemented until the asynchronous coordination slice`);
    },
  };
}
