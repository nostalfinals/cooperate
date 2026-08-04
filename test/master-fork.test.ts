import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyMasterSessionDirectory, masterSessionIdFromFile } from "../src/lifecycle.ts";
import { NativeSessionStore } from "../src/sessions.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("master fork Session copying", () => {
  it("copies the complete flat child namespace without rewriting nested Session bytes", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-fork-"));
    roots.push(agentDir);
    const source = join(agentDir, "cooperate", "sessions", "old-master");
    await mkdir(source, { recursive: true });
    const child = '{"type":"session","version":3,"id":"child-id","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/project"}\n' +
      '{"type":"custom","id":"anchor","parentId":null,"customType":"cooperate.child-session","data":{"sessionId":"nested-id"}}\n';
    await writeFile(join(source, "child.jsonl"), child);
    await writeFile(join(source, "hidden-branch-child.jsonl"), "hidden bytes\n");

    await copyMasterSessionDirectory(agentDir, "old-master", "new-master", { stagingName: ".copy-stage" });

    const copiedChild = join(agentDir, "cooperate", "sessions", "new-master", "child.jsonl");
    expect(await readFile(copiedChild, "utf8")).toBe(child);
    expect(await readFile(join(agentDir, "cooperate", "sessions", "new-master", "hidden-branch-child.jsonl"), "utf8")).toBe("hidden bytes\n");
    const reopened = await new NativeSessionStore({ agentDir, masterSessionId: "new-master", cwd: "/project" }).open("child-id");
    expect(reopened.file).toBe(copiedChild);

    await writeFile(copiedChild, "changed destination\n");
    expect(await readFile(join(source, "child.jsonl"), "utf8")).toBe(child);
  });

  it("rejects destination collisions and removes failed staging without touching the source", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-fork-"));
    roots.push(agentDir);
    const sessions = join(agentDir, "cooperate", "sessions");
    await mkdir(join(sessions, "old-master"), { recursive: true });
    await writeFile(join(sessions, "old-master", "child.jsonl"), "source\n");
    await mkdir(join(sessions, "new-master"));
    await expect(copyMasterSessionDirectory(agentDir, "old-master", "new-master")).rejects.toThrow("already exists");
    expect(await readFile(join(sessions, "old-master", "child.jsonl"), "utf8")).toBe("source\n");

    await rm(join(sessions, "new-master"), { recursive: true });
    await expect(copyMasterSessionDirectory(agentDir, "old-master", "new-master", {
      stagingName: ".copy-stage",
      copy: async () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");
    await expect(readFile(join(sessions, ".copy-stage", "child.jsonl"), "utf8")).rejects.toThrow();
    expect(await readFile(join(sessions, "old-master", "child.jsonl"), "utf8")).toBe("source\n");
  });

  it("resolves the previous master identity from native Session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "cooperate-master-"));
    roots.push(root);
    const file = join(root, "renamed-session.jsonl");
    await writeFile(file, '{"type":"session","version":3,"id":"metadata-id","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/project"}\n');
    expect(masterSessionIdFromFile(file)).toBe("metadata-id");
  });
});
