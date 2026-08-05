import { describe, expect, it, vi } from "vitest";
import type { DefinitionCatalog } from "../src/catalog.ts";
import { createCallerCatalog } from "../src/catalog.ts";
import { createSubagentTool } from "../src/subagent.ts";

const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, gcOrphanSessions: true },
  definitions: [{ name: "worker", description: "work", tools: [], subagentAgents: [], body: "work", filePath: "/worker.md" }],
  configPath: "/config",
  definitionsPath: "/defs",
};

const service = {
  run: vi.fn(),
  listSubagents: vi.fn(() => []),
  listSessions: vi.fn(async () => []),
  wait: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
};

const theme = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as never;

function lines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

describe("subagent tool renderer", () => {
  it("renders the exact action headers with semantic title, accent, and muted roles", () => {
    const tool = createSubagentTool(service, createCallerCatalog(catalog));
    const context = {} as never;

    expect(lines(tool.renderCall!({ action: "run", agent: "worker", task: "x" } as never, theme, context))[0])
      .toBe("<toolTitle><b>subagent run </b></toolTitle><accent>worker</accent>");
    expect(lines(tool.renderCall!({ action: "run", agent: "worker", task: "x", async: true } as never, theme, context))[0])
      .toBe("<toolTitle><b>subagent run </b></toolTitle><accent>worker</accent><muted> (async)</muted>");
    expect(lines(tool.renderCall!({ action: "wait", subagentIds: ["deadbeef", "cafebabe"] } as never, theme, context))[0])
      .toBe("<toolTitle><b>subagent wait </b></toolTitle><accent>deadbeef, cafebabe</accent>");
    expect(lines(tool.renderCall!({ action: "list-definitions" } as never, theme, context))[0])
      .toBe("<toolTitle><b>subagent list-definitions</b></toolTitle>");
  });

  it("streams blocking subtree snapshots through tool updates", async () => {
    const snapshot = {
      subagentId: "deadbeef", agent: "worker", sessionId: "session-1", task: "task", depth: 2,
      startedAt: 0, elapsedMs: 100, state: "running", children: [],
    } as const;
    const streamingService = {
      ...service,
      run: vi.fn(async (_request, environment) => {
        environment.onSnapshot?.(snapshot);
        return { sessionId: "session-1", result: "done", snapshot: { ...snapshot, state: "finished" as const } };
      }),
    };
    const tool = createSubagentTool(streamingService, createCallerCatalog(catalog));
    const onUpdate = vi.fn();
    await tool.execute("call", { action: "run", agent: "worker", task: "task" } as never, undefined, onUpdate, { cwd: "/", model: {} } as never);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ action: "run", snapshot }),
    }));
  });

  it("renders a width-safe blocking hierarchy with state marks, elapsed time, and expanded metadata", () => {
    const tool = createSubagentTool(service, createCallerCatalog(catalog));
    const snapshot = {
      subagentId: "deadbeef", agent: "worker", sessionId: "session-1", task: "implement a deliberately long task title",
      model: "anthropic/sonnet", thinking: "high", depth: 2, startedAt: 0, elapsedMs: 65_000, state: "finished",
      children: [{
        subagentId: "cafebabe", parentId: "deadbeef", agent: "reviewer", sessionId: "session-2", task: "review",
        model: "openai/gpt", thinking: "medium", depth: 3, startedAt: 1, elapsedMs: 2_000, state: "failed", reason: "boom", children: [],
      }],
    };
    const result = { content: [{ type: "text", text: "final answer" }], details: { action: "run", async: false, snapshot } } as never;
    const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never;
    const context = { args: { action: "run" }, state: {} } as never;

    const collapsed = tool.renderResult!(result, { expanded: false } as never, plainTheme, context).render(48);
    expect(collapsed.join("\n")).toContain("✓ worker deadbeef 1m05s");
    expect(collapsed.join("\n")).toContain("└─ × reviewer cafebabe 2s");
    expect(collapsed.every((line) => line.length <= 48)).toBe(true);

    const expanded = tool.renderResult!(result, { expanded: true } as never, plainTheme, context).render(100).join("\n");
    expect(expanded).toContain("model anthropic/sonnet · thinking high · session session-1");
    expect(expanded).toContain("failed: boom");
    expect(expanded).toContain("final answer");

    const retained = tool.renderResult!({ content: [{ type: "text", text: "tool failed" }] } as never, { expanded: true } as never, plainTheme, context)
      .render(100).join("\n");
    expect(retained).toContain("× reviewer cafebabe");
    expect(retained).toContain("tool failed");
  });

  it("keeps async and management results compact while expanded mode exposes complete tool text", () => {
    const tool = createSubagentTool(service, createCallerCatalog(catalog));
    const context = { args: { action: "run", async: true } } as never;
    const started = {
      content: [{ type: "text", text: "started deadbeef\nsession 018f-session" }],
      details: { action: "run", async: true, subagentId: "deadbeef", sessionId: "018f-session" },
    } as never;

    expect(lines(tool.renderResult!(started, { expanded: false } as never, theme, context))[0])
      .toBe("<success>started deadbeef</success>");
    expect(lines(tool.renderResult!(started, { expanded: true } as never, theme, context)).join("\n"))
      .toContain("started deadbeef\nsession 018f-session");

    const listed = {
      content: [{ type: "text", text: "[\n  {\"agent\":\"worker\"}\n]" }],
      details: { action: "list-subagents", count: 1 },
    } as never;
    expect(lines(tool.renderResult!(listed, { expanded: false } as never, theme, { args: { action: "list-subagents" } } as never))[0])
      .toBe("<muted>1 active subagent</muted>");
    expect(lines(tool.renderResult!(listed, { expanded: true } as never, theme, { args: { action: "list-subagents" } } as never)).join("\n"))
      .toContain("{\"agent\":\"worker\"}");
  });
});
