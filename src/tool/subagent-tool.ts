import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CallerCatalog } from "../catalog/types.ts";
import { isActive, type RunEnvironment, type RunRequest, type SubagentSnapshot } from "../subagent/types.ts";
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

interface LiveRun {
  snapshot?: SubagentSnapshot;
  unsubscribe?: () => void;
}

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
        const inspection = service.inspectSubagent(subagentId);
        return textResult(JSON.stringify(inspection, null, 2), { action, subagentId, snapshot, inspection });
      }
      if (action === "history") {
        const { subagentId, messageId, offset, limit } = params as unknown as {
          subagentId: string;
          messageId?: string;
          offset?: number;
          limit?: number;
        };
        const page = await service.historyMessages(subagentId, { messageId, offset, limit });
        return textResult(JSON.stringify(page, null, 2), { action, subagentId, snapshot: service.snapshotOrLast(subagentId), history: page });
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
    renderCall(args, theme, context) {
      let agent: string | undefined;
      const params = args as { action?: string; subagentId?: string };
      if ((params.action === "inspect" || params.action === "history" || params.action === "steer") && params.subagentId) {
        const service = caller !== undefined
          ? serviceOrResolver as SubagentToolService
          : (serviceOrResolver as SubagentToolResolver).service();
        agent = service?.snapshotOrLast(params.subagentId)?.agent;
      }
      const state = context.state as { details?: SubagentToolDetails };
      return renderSubagentCall(args, theme, agent, state.details);
    },
    renderResult(result, options, theme, context) {
      let details = result.details as SubagentToolDetails | undefined;
      if (details?.action === "inspect" || details?.action === "history") {
        const state = context.state as { sourceDetails?: SubagentToolDetails; details?: SubagentToolDetails };
        if (state.sourceDetails !== details) {
          state.sourceDetails = details;
          // Saved tool results already contain the observation, even without rendering metadata.
          if (!details.inspection && !details.history) {
            try {
              const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
              const observation = JSON.parse(text);
              details = details.action === "inspect"
                ? { ...details, inspection: observation }
                : { ...details, history: observation };
            } catch {
              // Truncated JSON cannot supply a preview; retain the call metadata.
            }
          }
          state.details = details;
          // Pi renders the header before the result; refresh it with the actual page range.
          queueMicrotask(context.invalidate);
        }
        details = state.details;
        result = { ...result, details };
      }
      if (details?.action === "run" && details.subagentId && !context.isError) {
        const service = caller !== undefined
          ? serviceOrResolver as SubagentToolService
          : (serviceOrResolver as SubagentToolResolver).service();
        const state = context.state as { liveRun?: LiveRun };
        if (!state.liveRun && service) {
          const subagentId = details.subagentId;
          const live: LiveRun = { snapshot: service.snapshotOrLast(subagentId) ?? details.snapshot };
          state.liveRun = live;
          if (live.snapshot && isActive(live.snapshot)) {
            live.unsubscribe = service.subscribe(() => {
              const snapshot = service.snapshotOrLast(subagentId);
              if (snapshot) live.snapshot = snapshot;
              if (!snapshot || !isActive(snapshot)) {
                live.unsubscribe?.();
                live.unsubscribe = undefined;
              }
              context.invalidate();
            });
          }
        }
        if (state.liveRun?.snapshot) {
          result = { ...result, details: { ...details, snapshot: state.liveRun.snapshot } };
        }
      }
      return renderSubagentResult(result, options, theme, context);
    },
  };
}
