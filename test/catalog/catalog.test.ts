import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCallerCatalog } from "../../src/catalog/catalog.ts";
import { loadCatalog } from "../../src/catalog/catalog.ts";
import { CatalogError, type CatalogLoadOptions } from "../../src/catalog/types.ts";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ agentDir: string; options: CatalogLoadOptions }> {
  const agentDir = await mkdtemp(join(tmpdir(), "cooperate-catalog-"));
  temporaryDirectories.push(agentDir);
  return {
    agentDir,
    options: {
      agentDir,
      availableTools: ["read", "bash", "subagent"],
      modelRegistry: {
        find: (provider, modelId) =>
          provider === "test" && modelId === "model/with/slash" ? { provider, id: modelId } : undefined,
      },
    },
  };
}

async function definition(agentDir: string, filename: string, content: string): Promise<string> {
  const directory = join(agentDir, "cooperate", "subagents");
  await mkdir(directory, { recursive: true });
  const file = join(directory, filename);
  await writeFile(file, content, "utf8");
  return resolve(file);
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadCatalog", () => {
  it("uses documented defaults when configuration and definitions are missing", async () => {
    const { options } = await fixture();

    const catalog = await loadCatalog(options);

    expect(catalog.config).toEqual({ maxDepth: 3, cleanOrphanSessions: true });
    expect(catalog.definitions).toEqual([]);
  });

  it("loads a strict valid catalog and preserves the Markdown body bytes", async () => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    await writeFile(
      join(agentDir, "cooperate", "config.json"),
      JSON.stringify({ maxDepth: 4, cleanOrphanSessions: false }),
    );
    await definition(
      agentDir,
      "worker.md",
      "---\r\nname: worker\r\ndescription: General worker\r\ntools: read, subagent\r\nsubagents: scout\r\nmodel: test/model/with/slash\r\nthinking: high\r\nsystem-prompt-mode: override\r\n---\r\nKeep CRLF.\r\nSecond line.\r\n",
    );
    await definition(
      agentDir,
      "scout.md",
      "---\nname: scout\ndescription: Search only\ntools: read\n---\nScout instructions.\n",
    );

    const catalog = await loadCatalog(options);

    expect(catalog.config).toEqual({ maxDepth: 4, cleanOrphanSessions: false });
    expect(catalog.definitions.map((item) => item.name)).toEqual(["scout", "worker"]);
    expect(catalog.definitions[1]).toMatchObject({
      name: "worker",
      description: "General worker",
      tools: ["read", "subagent"],
      subagentAgents: ["scout"],
      model: { provider: "test", modelId: "model/with/slash", reference: "test/model/with/slash" },
      thinking: "high",
      systemPromptMode: "override",
      body: "Keep CRLF.\r\nSecond line.\r\n",
    });
  });

  it.each([
    ["unknown field", { maxDepth: 3, cleanOrphanSessions: true, extra: true }],
    ["non-object", []],
    ["low depth", { maxDepth: 0, cleanOrphanSessions: true }],
    ["fractional depth", { maxDepth: 1.5, cleanOrphanSessions: true }],
    ["null depth", { maxDepth: null, cleanOrphanSessions: true }],
    ["wrong cleanup type", { maxDepth: 3, cleanOrphanSessions: "yes" }],
    ["null cleanup", { maxDepth: 3, cleanOrphanSessions: null }],
  ])("rejects invalid configuration: %s", async (_label, value) => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    const configPath = resolve(agentDir, "cooperate", "config.json");
    await writeFile(configPath, JSON.stringify(value));

    await expect(loadCatalog(options)).rejects.toThrow();
  });

  it("rejects malformed JSON configuration with a CatalogError", async () => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    await writeFile(resolve(agentDir, "cooperate", "config.json"), "{");

    await expect(loadCatalog(options)).rejects.toSatisfy((error: unknown) => error instanceof CatalogError);
  });

  it.each([
    ["missing frontmatter", "Instructions"],
    ["malformed YAML", "---\nname: [\n---\nBody"],
    ["unknown field", "---\nname: one\ndescription: One\nextra: no\n---\nBody"],
    ["invalid name", "---\nname: bad.name\ndescription: One\n---\nBody"],
    ["empty description", "---\nname: one\ndescription: '  '\n---\nBody"],
    ["wrong tools type", "---\nname: one\ndescription: One\ntools: [read]\n---\nBody"],
    ["empty tool", "---\nname: one\ndescription: One\ntools: read, ,bash\n---\nBody"],
    ["duplicate tool", "---\nname: one\ndescription: One\ntools: read, read\n---\nBody"],
    ["bad model", "---\nname: one\ndescription: One\nmodel: missing-slash\n---\nBody"],
    ["bad thinking", "---\nname: one\ndescription: One\nthinking: extreme\n---\nBody"],
    ["bad system prompt mode", "---\nname: one\ndescription: One\nsystem-prompt-mode: replace\n---\nBody"],
  ])("rejects invalid definitions: %s", async (_label, content) => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "invalid.md", content);

    await expect(loadCatalog(options)).rejects.toThrow();
  });

  it.each([
    ["unknown tool", "tools: write"],
    ["unknown model", "model: test/missing"],
    ["unknown child", "tools: subagent\nsubagents: missing"],
    ["children without tool", "subagents: scout"],
    ["wildcard children without tool", "subagents: \"*\""],
  ])("rejects unresolved catalog relationships atomically: %s", async (_label, fields) => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "one.md", `---\nname: one\ndescription: One\n${fields}\n---\nBody`);
    if (fields.includes("scout")) {
      await definition(agentDir, "scout.md", "---\nname: scout\ndescription: Scout\n---\nBody");
    }

    await expect(loadCatalog(options)).rejects.toThrow();
  });

  it("allows an empty Markdown body and defaults system-prompt-mode to append", async () => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "empty.md", "---\nname: empty\ndescription: No body\n---\n  \n");

    const catalog = await loadCatalog(options);

    expect(catalog.definitions[0]).toMatchObject({
      name: "empty",
      description: "No body",
      body: "  \n",
      systemPromptMode: undefined,
    });
  });

  it("treats '*' as the full tools and subagents set", async () => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "scout.md", "---\nname: scout\ndescription: Scout\ntools: read\n---\nScout");
    await definition(agentDir, "worker.md", "---\nname: worker\ndescription: Worker\ntools: \"*\"\nsubagents: \"*\"\n---\nWorker");

    const catalog = await loadCatalog(options);

    expect(catalog.definitions.map((item) => item.name)).toEqual(["scout", "worker"]);
    expect(catalog.definitions[1]).toMatchObject({ tools: ["*"], subagentAgents: ["*"] });
  });

  it.each([
    ["bare star", "---\nname: one\ndescription: One\ntools: *\n---\nBody"],
    ["star mixed with named tool", "---\nname: one\ndescription: One\ntools: read, \"*\"\n---\nBody"],
    ["star mixed with named child", "---\nname: one\ndescription: One\ntools: subagent\nsubagents: scout, \"*\"\n---\nBody"],
  ])("rejects invalid star usage: %s", async (_label, content) => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "invalid.md", content);

    await expect(loadCatalog(options)).rejects.toThrow();
  });

  it("explains that a bare '*' must be quoted in YAML", async () => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "one.md", "---\nname: one\ndescription: One\ntools: *\n---\nBody");

    await expect(loadCatalog(options)).rejects.toSatisfy(
      (error: unknown) => error instanceof CatalogError && error.message.includes('write "*" in quotes'),
    );
  });
});

describe("createCallerCatalog", () => {
  it("projects only caller-allowed names and descriptions into a constrained schema", async () => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "a.md", "---\nname: alpha\ndescription: Alpha tasks\n---\nA");
    await definition(agentDir, "b.md", "---\nname: beta\ndescription: Beta tasks\n---\nB");
    const catalog = await loadCatalog(options);

    const caller = createCallerCatalog(catalog, ["beta"]);

    expect(caller.definitions.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "beta", description: "Beta tasks" },
    ]);
  });
});
