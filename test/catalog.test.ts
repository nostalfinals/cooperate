import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatalogError,
  createCallerCatalog,
  loadCatalog,
  type CatalogLoadOptions,
} from "../src/catalog.ts";

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

    expect(catalog.config).toEqual({ maxDepth: 3, gcOrphanSessions: true });
    expect(catalog.definitions).toEqual([]);
  });

  it("loads a strict valid catalog and preserves the Markdown body bytes", async () => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    await writeFile(
      join(agentDir, "cooperate", "config.json"),
      JSON.stringify({ maxDepth: 4, gcOrphanSessions: false }),
    );
    await definition(
      agentDir,
      "worker.md",
      "---\r\nname: worker\r\ndescription: General worker\r\ntools: read, subagent\r\nsubagent_agents: scout\r\nmodel: test/model/with/slash\r\nthinking: high\r\n---\r\nKeep CRLF.\r\nSecond line.\r\n",
    );
    await definition(
      agentDir,
      "scout.md",
      "---\nname: scout\ndescription: Search only\ntools: read\n---\nScout instructions.\n",
    );

    const catalog = await loadCatalog(options);

    expect(catalog.config).toEqual({ maxDepth: 4, gcOrphanSessions: false });
    expect(catalog.definitions.map((item) => item.name)).toEqual(["scout", "worker"]);
    expect(catalog.definitions[1]).toMatchObject({
      name: "worker",
      description: "General worker",
      tools: ["read", "subagent"],
      subagentAgents: ["scout"],
      model: { provider: "test", modelId: "model/with/slash", reference: "test/model/with/slash" },
      thinking: "high",
      body: "Keep CRLF.\r\nSecond line.\r\n",
    });
  });

  it.each([
    ["unknown field", { maxDepth: 3, gcOrphanSessions: true, extra: true }, "unknown field 'extra'"],
    ["non-object", [], "must be a JSON object"],
    ["low depth", { maxDepth: 0, gcOrphanSessions: true }, "maxDepth must be an integer of at least 1"],
    ["fractional depth", { maxDepth: 1.5, gcOrphanSessions: true }, "maxDepth must be an integer of at least 1"],
    ["null depth", { maxDepth: null, gcOrphanSessions: true }, "maxDepth must be an integer of at least 1"],
    ["wrong GC type", { maxDepth: 3, gcOrphanSessions: "yes" }, "gcOrphanSessions must be a boolean"],
    ["null GC", { maxDepth: 3, gcOrphanSessions: null }, "gcOrphanSessions must be a boolean"],
  ])("rejects invalid configuration: %s", async (_label, value, reason) => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    const configPath = resolve(agentDir, "cooperate", "config.json");
    await writeFile(configPath, JSON.stringify(value));

    await expect(loadCatalog(options)).rejects.toThrow(`${configPath}: ${reason}`);
  });

  it("reports malformed JSON with its resolved source path", async () => {
    const { agentDir, options } = await fixture();
    await mkdir(join(agentDir, "cooperate"), { recursive: true });
    const configPath = resolve(agentDir, "cooperate", "config.json");
    await writeFile(configPath, "{");

    await expect(loadCatalog(options)).rejects.toSatisfy(
      (error: unknown) => error instanceof CatalogError && error.message.startsWith(`${configPath}: malformed JSON:`),
    );
  });

  it.each([
    ["missing frontmatter", "Instructions", "YAML frontmatter is required"],
    ["malformed YAML", "---\nname: [\n---\nBody", "malformed YAML"],
    ["unknown field", "---\nname: one\ndescription: One\nextra: no\n---\nBody", "unknown frontmatter field 'extra'"],
    ["invalid name", "---\nname: bad.name\ndescription: One\n---\nBody", "name must match"],
    ["empty description", "---\nname: one\ndescription: '  '\n---\nBody", "description must be nonempty"],
    ["empty body", "---\nname: one\ndescription: One\n---\n  \n", "Markdown body must be nonempty"],
    ["wrong tools type", "---\nname: one\ndescription: One\ntools: [read]\n---\nBody", "tools must be a comma-separated string"],
    ["empty tool", "---\nname: one\ndescription: One\ntools: read, ,bash\n---\nBody", "tools contains an empty entry"],
    ["duplicate tool", "---\nname: one\ndescription: One\ntools: read, read\n---\nBody", "tools contains duplicate entry 'read'"],
    ["bad model", "---\nname: one\ndescription: One\nmodel: missing-slash\n---\nBody", "model must use provider/modelId"],
    ["bad thinking", "---\nname: one\ndescription: One\nthinking: extreme\n---\nBody", "thinking must be one of"],
  ])("rejects invalid definitions: %s", async (_label, content, reason) => {
    const { agentDir, options } = await fixture();
    const file = await definition(agentDir, "invalid.md", content);

    await expect(loadCatalog(options)).rejects.toThrow(`${file}: ${reason}`);
  });

  it.each([
    ["unknown tool", "tools: write", "unavailable tool 'write'"],
    ["unknown model", "model: test/missing", "model 'test/missing' is absent from Pi's registry"],
    ["unknown child", "tools: subagent\nsubagent_agents: missing", "unknown Definition 'missing'"],
    ["children without tool", "subagent_agents: scout", "requires 'subagent' in tools"],
  ])("rejects unresolved catalog relationships atomically: %s", async (_label, fields, reason) => {
    const { agentDir, options } = await fixture();
    await definition(agentDir, "one.md", `---\nname: one\ndescription: One\n${fields}\n---\nBody`);
    if (fields.includes("scout")) {
      await definition(agentDir, "scout.md", "---\nname: scout\ndescription: Scout\n---\nBody");
    }

    await expect(loadCatalog(options)).rejects.toThrow(reason);
  });

  it("rejects duplicate authoritative names even when filenames differ", async () => {
    const { agentDir, options } = await fixture();
    const first = await definition(agentDir, "a.md", "---\nname: same\ndescription: A\n---\nA");
    const second = await definition(agentDir, "b.md", "---\nname: same\ndescription: B\n---\nB");

    await expect(loadCatalog(options)).rejects.toThrow(
      `${second}: duplicate Definition name 'same' (already defined in ${first})`,
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
    expect(caller.agentSchema).toMatchObject({ type: "string", enum: ["beta"] });
    expect(caller.discovery).toBe("Available subagent definitions:\n\n- beta: Beta tasks");
    expect(caller.discovery).not.toContain("alpha");
  });
});
