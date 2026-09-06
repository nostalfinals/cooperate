import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCooperateExtension } from "../../src/index.ts";
import * as catalogs from "../../src/catalog/catalog.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const agentDir = await mkdtemp(join(tmpdir(), "cooperate-working-"));
  roots.push(agentDir);
  vi.spyOn(catalogs, "loadCatalog").mockResolvedValue({
    config: { maxDepth: 3, cleanOrphanSessions: false },
    definitions: [{ name: "worker", description: "work", tools: [], subagentAgents: [], body: "work", filePath: "/worker.md" }],
    configPath: "/config", definitionsPath: "/defs",
  });
  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  let tool!: ToolDefinition;
  const controller = new AbortController();
  const ctx = {
    cwd: agentDir, model: {}, modelRegistry: {}, signal: controller.signal,
    isIdle: () => false, hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "master", getSessionDir: () => agentDir, getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  const runs: Array<{ finish(): void; abort: ReturnType<typeof vi.fn> }> = [];
  const pi = {
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (registered: ToolDefinition) => { tool = registered; },
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), appendEntry: vi.fn(),
    getAllTools: () => [], sendMessage: vi.fn(),
  };
  await createCooperateExtension({
    agentDir,
    runtimeFactory: { start: async () => {
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => { finish = resolve; });
      const abort = vi.fn(() => finish());
      runs.push({ finish, abort });
      return {
        prompt: () => promise, abort, dispose: async () => undefined,
        messagesSinceStart: () => [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      };
    } },
  })(pi as unknown as ExtensionAPI);
  const emit = async (event: string, data: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(data as never, ctx);
  };
  await emit("session_start", { reason: "startup" });
  await emit("agent_start");
  for (const id of ["first", "second"]) {
    await tool.execute(id, { action: "run", agent: "worker", task: id, prompt: id }, controller.signal, undefined, ctx);
    await emit("message_end", { message: { role: "toolResult", toolName: "subagent", toolCallId: id } });
  }
  return { emit, runs, controller, pi };
}

describe("main agent Working lifecycle", () => {
  it("holds agent_end while children run and cancels all of them on the main abort signal", async () => {
    const h = await harness();
    const settled = vi.fn();
    const waiting = h.emit("agent_end", { messages: [] }).then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();

    h.controller.abort();
    await waiting;
    for (const run of h.runs) expect(run.abort).toHaveBeenCalledOnce();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("releases agent_end when a completion is delivered, without waiting for the other child", async () => {
    const h = await harness();
    const waiting = h.emit("agent_end", { messages: [] });
    h.runs[0]!.finish();
    await waiting;
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    expect(h.runs[1]!.abort).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("lets new user input resume the caller without cancelling its children", async () => {
    const h = await harness();
    const waiting = h.emit("agent_end", { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await h.emit("input", { source: "interactive", text: "status?" });
    await waiting;
    for (const run of h.runs) expect(run.abort).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });
});
