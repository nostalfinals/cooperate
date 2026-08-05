import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createCallerCatalog, formatDefinitionDiscovery } from "../../src/catalog/catalog.ts";
import type { DefinitionCatalog } from "../../src/catalog/definitions.ts";
import { createCooperateExtension } from "../../src/index.ts";
import { injectDefinitionDiscovery } from "../../src/prompt.ts";
import { createSubagentTool } from "../../src/tool/subagent-tool.ts";

const catalog: DefinitionCatalog = {
  config: { maxDepth: 3, gcOrphanSessions: true },
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
  ...overrides,
});

describe("Definition discovery text", () => {
  it("injects discovery at the native append boundary without duplicating it", () => {
    const prompt = "Base\n\nExisting append\n\n<project_context>\ncontext\n</project_context>\nCurrent working directory: /project";
    const discovery = formatDefinitionDiscovery(createCallerCatalog(catalog).definitions);
    const structured = options({ appendSystemPrompt: "Existing append", contextFiles: [{ path: "/project/AGENTS.md", content: "context" }] });

    const injected = injectDefinitionDiscovery(prompt, structured, discovery);

    expect(injected.indexOf(discovery)).toBeGreaterThan(-1);
    expect(injected.indexOf(discovery)).toBeLessThan(injected.indexOf("Existing append"));
    expect(injectDefinitionDiscovery(injected, structured, discovery)).toBe(injected);
    expect(injectDefinitionDiscovery(injected, structured, "No subagent is defined yet")).toBe(injected);
  });
});

describe("Definition discovery action", () => {
  it("keeps the agent name unconstrained and returns the caller-scoped discovery text", async () => {
    const caller = createCallerCatalog(catalog, ["scout"]);
    const tool = createSubagentTool({} as never, caller);
    const schema = tool.parameters as { anyOf: Array<{ properties: Record<string, { const?: string; type?: string; enum?: string[] }> }> };

    expect(schema.anyOf.map((shape) => shape.properties.action.const)).toContain("list-definitions");
    const runShape = schema.anyOf.find((shape) => shape.properties.action.const === "run");
    expect(runShape?.properties.agent.type).toBe("string");
    expect(runShape?.properties.agent.enum).toBeUndefined();

    const result = await tool.execute("call", { action: "list-definitions" } as never, undefined, undefined, { cwd: "/project" } as never);
    expect(result.content).toEqual([{ type: "text", text: caller.discovery }]);
  });
});

describe("main prompt discovery", () => {
  it("adds the full catalog before existing append content while preserving chained prompt changes", async () => {
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
      const result = (await before?.({
        systemPrompt: "Earlier extension\nBase\n\nExisting append\nCurrent working directory: /project",
        systemPromptOptions: options({ appendSystemPrompt: "Existing append" }),
      }, {})) as { systemPrompt?: string } | undefined;
      const systemPrompt = result?.systemPrompt ?? "";
      const discovery = formatDefinitionDiscovery([
        { name: "worker", description: "General work" },
        { name: "scout", description: "Search only" },
      ]);

      expect(systemPrompt.startsWith("Earlier extension\nBase")).toBe(true);
      expect(systemPrompt.indexOf(discovery)).toBeGreaterThan(-1);
      expect(systemPrompt.indexOf(discovery)).toBeLessThan(systemPrompt.indexOf("Existing append"));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
