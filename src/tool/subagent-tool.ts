import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CallerCatalog } from "../catalog/types.ts";
import type { RunEnvironment, RunRequest, SubagentSnapshot } from "../subagent/types.ts";
import type { SubagentToolService } from "./types.ts";
import { truncateForTool } from "../text.ts";
import { actionSchema } from "./schema.ts";
import {
  renderCall as renderSubagentCall,
  renderResult as renderSubagentResult,
  type SubagentToolDetails,
} from "./renderer.ts";

function textResult(value: string, details: SubagentToolDetails): AgentToolResult<SubagentToolDetails> {
  return { content: [{ type: "text", text: truncateForTool(value) }], details };
}

function emptyResult(details: SubagentToolDetails): AgentToolResult<SubagentToolDetails> {
  return { content: [], details };
}

export interface SubagentToolResolver {
  service(): SubagentToolService | undefined;
  caller(): CallerCatalog | undefined;
}

type ToolDependencies = readonly [service: SubagentToolService, caller: CallerCatalog];

export function createSubagentTool(service: SubagentToolService, caller: CallerCatalog): ToolDefinition;
export function createSubagentTool(resolver: SubagentToolResolver): ToolDefinition;
export function createSubagentTool(
  serviceOrResolver: SubagentToolService | SubagentToolResolver,
  caller?: CallerCatalog,
): ToolDefinition {
  const resolve = (): ToolDependencies => {
    if (caller !== undefined) return [serviceOrResolver as SubagentToolService, caller];
    const lazy = serviceOrResolver as SubagentToolResolver;
    const service = lazy.service();
    const catalog = lazy.caller();
    if (!service || !catalog) throw new Error("subagent tool is unavailable outside an active session");
    return [service, catalog];
  };
  const requireSubagentId = (params: Record<string, unknown>): string => {
    const subagentId = params.subagentId;
    if (typeof subagentId !== "string" || subagentId.length === 0) {
      throw new Error(`action '${params.action}' requires subagentId`);
    }
    return subagentId;
  };
  return {
    name: "subagent",
    label: "subagent",
    description: "Run and manage configured subagents and their sessions. The subagents will run in the background. You will be notified when they complete.",
    parameters: actionSchema(),
    async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const [service, caller] = resolve();
      const action = (params as { action: string }).action;
      if (action === "run") {
        const request = params as unknown as RunRequest;
        let latestSnapshot: SubagentSnapshot | undefined;
        const result = await service.run(request, {
          cwd: ctx.cwd,
          creatorModel: ctx.model,
          signal,
          toolCallId,
          onSnapshot: (snapshot) => {
            latestSnapshot = snapshot;
            onUpdate?.({
              content: [],
              details: { action, subagentId: snapshot.subagentId, sessionId: snapshot.sessionId, snapshot },
            });
          },
        } as RunEnvironment);
        return textResult(result.result, {
          action,
          subagentId: result.subagentId,
          sessionId: result.sessionId,
          snapshot: latestSnapshot,
        });
      }
      if (action === "list-definitions") return textResult(caller.discovery, { action, count: caller.definitions.length });
      if (action === "list-subagents") {
        const all = (params as unknown as { all?: boolean }).all === true;
        const entries = service.listSubagents(all);
        return textResult(JSON.stringify(entries, null, 2), { action, all, count: entries.length });
      }
      if (action === "list-sessions") {
        const entries = await service.listSessions();
        return textResult(JSON.stringify(entries, null, 2), { action, count: entries.length });
      }
      if (action === "inspect") {
        const subagentId = requireSubagentId(params as unknown as Record<string, unknown>);
        const snapshot = service.snapshotOrLast(subagentId);
        return textResult(JSON.stringify(service.inspectSubagent(subagentId), null, 2), { action, subagentId, snapshot });
      }
      if (action === "history") {
        const { subagentId, messageId, offset, limit } = params as unknown as {
          subagentId: string;
          messageId?: string;
          offset?: number;
          limit?: number;
        };
        const page = await service.historyMessages(subagentId, { messageId, offset, limit });
        return textResult(JSON.stringify(page, null, 2), { action, subagentId, snapshot: service.snapshotOrLast(subagentId) });
      }
      if (action === "steer") {
        const { subagentId, text } = params as unknown as { subagentId: string; text: string };
        if (typeof text !== "string" || text.trim().length === 0) throw new Error("steer requires nonempty text");
        await service.steer(subagentId, text);
        return textResult(`Steered subagent ${subagentId}.`, { action, subagentId, snapshot: service.snapshotOrLast(subagentId) });
      }
      if (action === "cancel") {
        const subagentId = requireSubagentId(params as unknown as Record<string, unknown>);
        onUpdate?.({
          content: [],
          details: { action: "cancel", snapshot: service.snapshotOrLast(subagentId) },
        });
        const snapshot = await service.cancel(subagentId);
        return emptyResult({ action: "cancel", snapshot });
      }
      throw new Error(`Unknown subagent action '${action}'`);
    },
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  };
}
