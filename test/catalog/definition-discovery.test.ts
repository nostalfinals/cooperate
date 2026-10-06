import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, formatDefinitionDiscovery } from "../../src/catalog/catalog.ts";
import type { DefinitionCatalog } from "../../src/catalog/definitions.ts";
import { createCooperateExtension } from "../../src/index.ts";
import { createSubagentTool } from "../../src/tool/subagent-tool.ts";

const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, cleanOrphanSessions: true },
  definitions: [
    { name: "worker", description: "General work", tools: ["read"], subagentAgents: ["scout"], body: "Worker body", filePath: "/defs/worker.md" },
    { name: "scout", description: "Search only", tools: [], subagentAgents: [], body: "Scout body", filePath: "/defs/scout.md" },
  ],
  configPath: "/config.json",
  definitionsPath: "/defs",
};

const options = (overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions => ({
  cwd: "/project",
  selectedTools: ["read"],
  sections: {},
  ...overrides,
});

describe("Definition discovery action", () => {
  it("keeps the agent name unconstrained and returns the caller-scoped discovery text", async () => {
    const caller = createCallerCatalog(catalog, ["scout"]);
    const tool = createSubagentTool({} as never, caller);
    const schema = tool.parameters as {
      properties: { action: { enum?: string[] }; agent: { type?: string; enum?: string[] } };
    };

    expect(schema.properties.action.enum).toContain("list-definitions");
    expect(schema.properties.agent.type).toBe("string");
    expect(schema.properties.agent.enum).toBeUndefined();

    const result = await tool.execute("call", { action: "list-definitions" } as never, undefined, undefined, { cwd: "/project" } as never);
    expect(result.content).toEqual([{ type: "text", text: caller.discovery }]);
  });
});

describe("main prompt discovery", () => {
  it("sets the full catalog section without replacing other prompt state", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-discovery-"));
    try {
      const definitions = join(agentDir, "cooperate", "subagents");
      await mkdir(definitions, { recursive: true });
      await writeFile(join(definitions, "a.md"), "---\nname: worker\ndescription: General work\n---\nWorker body");
      await writeFile(join(definitions, "b.md"), "---\nname: scout\ndescription: Search only\n---\nScout body");

      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      const pi = {
        on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        }),
        getAllTools: vi.fn(() => [{ name: "read" }]),
        appendEntry: vi.fn(),
        registerTool: vi.fn(),
        registerMessageRenderer: vi.fn(),
        registerCommand: vi.fn(),
      };
      createCooperateExtension({ agentDir, runtimeFactory: {} as never })(pi as never);
      await handlers.get("session_start")?.[0]?.({}, {
        cwd: "/project",
        modelRegistry: { find: vi.fn() },
        sessionManager: {
          getSessionId: () => "master",
          getSessionDir: () => join(agentDir, "sessions"),
          getBranch: () => [],
        },
      });

      const before = handlers.get("before_agent_start")?.[0];
      const structured = options({ appendSystemPrompt: "Existing append", sections: { other: "Earlier extension" } });
      const result = await before?.({ systemPromptOptions: structured }, {});
      const discovery = formatDefinitionDiscovery([
        { name: "worker", description: "General work" },
        { name: "scout", description: "Search only" },
      ]);

      expect(result).toBeUndefined();
      expect(structured.sections).toEqual({ other: "Earlier extension", subagent_definitions: discovery });
      expect(structured.appendSystemPrompt).toBe("Existing append");
      await before?.({ systemPromptOptions: structured }, {});
      expect(structured.sections).toEqual({ other: "Earlier extension", subagent_definitions: discovery });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
