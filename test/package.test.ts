import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCooperateExtension } from "../src/index.ts";

interface PackageManifest {
  private?: boolean;
  type?: string;
  pi?: { extensions?: string[] };
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

describe("Pi package metadata", () => {
  it("declares the TypeScript extension and unbundled Pi peers", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as PackageManifest;

    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.scripts).toMatchObject({ test: "vitest run", typecheck: "tsc --noEmit" });
    expect(manifest.peerDependencies).toEqual({
      "@earendil-works/pi-agent-core": "*",
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      typebox: "*",
    });
  });

  it("initializes catalog state per session and shuts down idempotently", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
      getAllTools: vi.fn(() => [{ name: "read" }]),
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn(),
    };
    const extension = createCooperateExtension({ agentDir: resolve("test/fixtures/missing-agent-dir") });

    extension(pi as never);
    expect(pi.registerMessageRenderer).toHaveBeenCalledWith("subagent", expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith("subagents", expect.objectContaining({ handler: expect.any(Function) }));
    expect([...handlers.keys()]).toEqual([
      "agent_start", "agent_end", "message_end", "session_start", "before_agent_start", "session_before_tree", "session_shutdown",
    ]);

    const context = {
      cwd: "/project",
      modelRegistry: { find: vi.fn() },
      sessionManager: {
        getSessionId: () => "master-id",
        getSessionDir: () => resolve("test/fixtures/missing-agent-dir/sessions"),
        getBranch: () => [],
      },
    };
    await handlers.get("session_start")?.({}, context);
    expect(pi.registerTool).toHaveBeenCalledOnce();
    const tool = pi.registerTool.mock.calls[0][0] as {
      name: string;
      parameters: { type?: string; anyOf: Array<{ properties: { action: { const: string } } }> };
    };
    expect(tool.name).toBe("subagent");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.anyOf.map((shape) => shape.properties.action.const)).toEqual([
      "run", "list-definitions", "list-subagents", "list-sessions", "wait", "cancel",
    ]);

    await handlers.get("session_shutdown")?.({}, context);
    await handlers.get("session_shutdown")?.({}, context);
  });
});
