import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NativeSessionStore } from "../src/sessions/native-store.ts";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "../src/sessions/ownership.ts";
import { truncateForTool } from "../src/text.ts";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("native child Sessions", () => {
  it("creates native JSONL in the master namespace and opens it by native ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "cooperate-sessions-"));
    directories.push(root);
    const store = new NativeSessionStore({ agentDir: root, masterSessionId: "master-id", cwd: "/project" });

    const created = await store.create();
    const raw = await readFile(created.file, "utf8");
    const header = JSON.parse(raw.trim());

    expect(created.sessionId).toBe(header.id);
    expect(created.file).toContain(join("cooperate", "sessions", "master-id"));
    expect((await store.open(created.sessionId)).file).toBe(created.file);
  });

  it("derives direct visibility only from ownership entries on the active branch", () => {
    expect(ownedSessionIds([
      { type: "custom", customType: OWNERSHIP_ENTRY, data: { sessionId: "one" } },
      { type: "custom", customType: "other", data: { sessionId: "ignored" } },
      { type: "custom", customType: OWNERSHIP_ENTRY, data: { sessionId: "two" } },
    ])).toEqual(["one", "two"]);
  });

  it("lists exact public fields and derives latest real task/result from native history", async () => {
    const root = await mkdtemp(join(tmpdir(), "cooperate-sessions-"));
    directories.push(root);
    const store = new NativeSessionStore({ agentDir: root, masterSessionId: "master-id", cwd: "/project" });
    const record = await store.create();
    const manager = SessionManager.open(record.file, store.directory, "/project");
    manager.appendMessage({ role: "user", content: "old task", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old result" }], api: "openai-responses", provider: "openai", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
    manager.appendCustomMessageEntry("cooperate.completion", "not a task", false);
    manager.appendMessage({ role: "user", content: "latest task", timestamp: 3 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "latest result" }], api: "openai-responses", provider: "openai", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 });

    expect(await store.inspect(record)).toEqual({ task: "latest task", result: "latest result" });
  });
});

describe("tool output truncation", () => {
  it("obeys Pi's 2000-line and 50KB limits while retaining the head", () => {
    const lines = Array.from({ length: 2100 }, (_, index) => `line-${index}`).join("\n");
    const lineResult = truncateForTool(lines);
    expect(lineResult.split("\n").length).toBeLessThanOrEqual(2000);
    const byteResult = truncateForTool("x".repeat(60 * 1024) + "\nsecond");
    expect(byteResult.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(byteResult)).toBeLessThanOrEqual(50 * 1024);
  });
});
