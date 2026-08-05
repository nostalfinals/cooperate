import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CallerCatalog } from "../catalog.ts";
import type { RunEnvironment, RunRequest, SubagentSnapshot } from "../subagent/types.ts";
import type { SubagentToolService } from "../subagent/ports.ts";
import { truncateForTool } from "../sessions.ts";
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

export function createSubagentTool(service: SubagentToolService, caller: CallerCatalog): ToolDefinition {
  return {
    name: "subagent",
    label: "subagent",
    description: "Run and manage configured subagents and their Sessions.",
    parameters: actionSchema(caller.agentSchema),
    async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
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
              details: { action, async: request.async === true, subagentId: snapshot.subagentId, sessionId: snapshot.sessionId, snapshot },
            });
          },
        } as RunEnvironment);
        return textResult(result.result, {
          action,
          async: request.async === true,
          subagentId: result.subagentId,
          sessionId: result.sessionId,
          snapshot: latestSnapshot,
        });
      }
      if (action === "list-definitions") return textResult(caller.discovery, { action, count: caller.definitions.length });
      if (action === "list-subagents") {
        const entries = service.listSubagents();
        return textResult(JSON.stringify(entries, null, 2), { action, count: entries.length });
      }
      if (action === "list-sessions") {
        const entries = await service.listSessions();
        return textResult(JSON.stringify(entries, null, 2), { action, count: entries.length });
      }
      if (action === "wait") {
        await service.wait((params as unknown as { subagentIds: string[] }).subagentIds);
        return textResult("wait complete", { action });
      }
      if (action === "cancel") {
        await service.cancel((params as unknown as { subagentId: string }).subagentId);
        return emptyResult({ action });
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

export function createSubagentDiscoveryTool(caller: CallerCatalog): ToolDefinition {
  const unavailable = (): never => { throw new Error("nested subagent coordination is unavailable"); };
  return createSubagentTool({
    run: async () => unavailable(),
    listSubagents: unavailable,
    listSessions: async () => unavailable(),
    wait: async () => unavailable(),
    cancel: async () => unavailable(),
  }, caller);
}
