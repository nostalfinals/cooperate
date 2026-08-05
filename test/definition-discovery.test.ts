import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
  createCallerCatalog,
  formatDefinitionDiscovery,
  type DefinitionCatalog,
} from "../src/catalog.ts";
import { createCooperateExtension } from "../src/index.ts";
import { injectDefinitionDiscovery } from "../src/prompt.ts";
import { createSubagentTool } from "../src/subagent.ts";

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
  it("formats available Definitions in caller order and the exact empty response", () => {
    expect(formatDefinitionDiscovery(createCallerCatalog(catalog).definitions)).toBe(
      "Available subagent definitions:\n\n- worker: General work\n- scout: Search only",
    );
    expect(formatDefinitionDiscovery([])).toBe("No subagent is defined yet");
    expect(formatDefinitionDiscovery(createCallerCatalog(catalog, ["scout"]).definitions)).toBe(
      "Available subagent definitions:\n\n- scout: Search only",
    );
  });

  it("injects discovery at the native append boundary without duplicating it", () => {
    const prompt = "Base\n\nExisting append\n\n<project_context>\ncontext\n</project_context>\nCurrent working directory: /project";
    const discovery = formatDefinitionDiscovery(createCallerCatalog(catalog).definitions);
    const structured = options({ appendSystemPrompt: "Existing append", contextFiles: [{ path: "/project/AGENTS.md", content: "context" }] });

    const injected = injectDefinitionDiscovery(prompt, structured, discovery);

    expect(injected).toBe("Base\n\nAvailable subagent definitions:\n\n- worker: General work\n- scout: Search only\n\nExisting append\n\n<project_context>\ncontext\n</project_context>\nCurrent working directory: /project");
    expect(injectDefinitionDiscovery(injected, structured, discovery)).toBe(injected);
    expect(injectDefinitionDiscovery(injected, structured, "No subagent is defined yet")).toBe(injected);
  });
});

describe("Definition discovery action", () => {
  it("uses a generic description, retains the constrained run enum, and returns the shared formatter output", async () => {
    const caller = createCallerCatalog(catalog, ["scout"]);
    const tool = createSubagentTool({} as never, caller);
    const schema = tool.parameters as { anyOf: Array<{ properties: Record<string, { const?: string; enum?: string[] }> }> };

    expect(tool.description).toBe("Run and manage configured subagents and their Sessions.");
    expect(tool.description).not.toContain("scout");
    expect(schema.anyOf.map((shape) => shape.properties.action.const)).toContain("list-definitions");
    expect(schema.anyOf.find((shape) => shape.properties.action.const === "run")?.properties.agent.enum).toEqual(["scout"]);

    const result = await tool.execute("call", { action: "list-definitions" } as never, undefined, undefined, { cwd: "/project" } as never);
    expect(result.content).toEqual([{ type: "text", text: "Available subagent definitions:\n\n- scout: Search only" }]);
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
      const result = await before?.({
        systemPrompt: "Earlier extension\nBase\n\nExisting append\nCurrent working directory: /project",
        systemPromptOptions: options({ appendSystemPrompt: "Existing append" }),
      }, {});

      expect(result).toEqual({
        systemPrompt: "Earlier extension\nBase\n\nAvailable subagent definitions:\n\n- worker: General work\n- scout: Search only\n\nExisting append\nCurrent working directory: /project",
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
