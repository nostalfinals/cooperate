import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectMasterSessionIds,
  cleanOrphanSessions,
  selectOrphanSessionDirectories,
} from "../../src/session/orphan-cleanup.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function present(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe("orphan master session cleanup", () => {
  it("selects only complete namespaces whose master session no longer exists", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-"));
    roots.push(agentDir);
    const masters = join(agentDir, "sessions", "--project--");
    await mkdir(masters, { recursive: true });
    await writeFile(join(masters, "renamed.jsonl"), '{"type":"session","version":3,"id":"live-master","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/project"}\n');
    const customSessions = join(agentDir, "custom-sessions");
    await mkdir(customSessions);
    await writeFile(join(customSessions, "custom.jsonl"), '{"type":"session","version":3,"id":"custom-master","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/project"}\n');
    const root = join(agentDir, "cooperate", "sessions");
    await mkdir(join(root, "live-master"), { recursive: true });
    await mkdir(join(root, "custom-master"));
    await mkdir(join(root, "orphan-master"));
    await mkdir(join(root, ".copy-incomplete"));

    const ids = await collectMasterSessionIds(agentDir, [customSessions]);
    expect(ids).toEqual(new Set(["live-master", "custom-master"]));
    expect(await selectOrphanSessionDirectories(root, ids)).toEqual([join(root, "orphan-master")]);
  });

  it("uses trash when available and recursively removes only as a fallback", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-"));
    roots.push(agentDir);
    const root = join(agentDir, "cooperate", "sessions");
    const trashed = join(root, "trash-me");
    const fallback = join(root, "remove-me");
    await mkdir(trashed, { recursive: true });
    await writeFile(join(trashed, "child"), "bytes");
    const trash = vi.fn(async (path: string) => {
      await rm(path, { recursive: true });
      return true;
    });
    await cleanOrphanSessions(agentDir, new Set(), { trash });
    expect(trash).toHaveBeenCalledWith(trashed);
    expect(await present(trashed)).toBe(false);

    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, "child"), "bytes");
    await cleanOrphanSessions(agentDir, new Set(), { trash: async () => false });
    expect(await present(fallback)).toBe(false);
  });

  it("aborts removals when shouldProceed turns false", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-"));
    roots.push(agentDir);
    const root = join(agentDir, "cooperate", "sessions");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const trash = vi.fn(async (path: string) => {
      await rm(path, { recursive: true });
      return true;
    });
    let checks = 0;
    await cleanOrphanSessions(agentDir, new Set(), {
      trash,
      shouldProceed: () => ++checks <= 1,
    });
    expect(await present(first)).toBe(false);
    expect(await present(second)).toBe(true);
  });

  it("completes an in-flight removal but starts no new ones after invalidation", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-"));
    roots.push(agentDir);
    const root = join(agentDir, "cooperate", "sessions");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    let proceed = true;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = false;
    const trash = vi.fn(async (path: string) => {
      if (path === first) {
        firstStarted = true;
        // Hold the in-flight removal until the test invalidates the run, like
        // a session replacement bumping the generation mid-deletion.
        await firstGate;
      }
      await rm(path, { recursive: true });
      return true;
    });
    const run = cleanOrphanSessions(agentDir, new Set(), {
      trash,
      shouldProceed: () => proceed,
    });
    await vi.waitFor(() => expect(firstStarted).toBe(true));
    proceed = false;
    releaseFirst();
    await run;
    // The removal already in flight finishes; the later one is aborted, so a
    // namespace created by a newer session can never be deleted.
    expect(await present(first)).toBe(false);
    expect(await present(second)).toBe(true);
  });

  it("does not collect a fork source before the copied destination is established", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "cooperate-cleanup-"));
    roots.push(agentDir);
    const source = join(agentDir, "cooperate", "sessions", "source-master");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "child.jsonl"), "source bytes\n");
    const { copyMasterSessionDirectory } = await import("../../src/session/master-copy.ts");

    await copyMasterSessionDirectory(agentDir, "source-master", "fork-master", { stagingName: ".copy-stage" });
    await cleanOrphanSessions(agentDir, new Set(["fork-master"]), { trash: async () => false });

    expect(await readFile(join(agentDir, "cooperate", "sessions", "fork-master", "child.jsonl"), "utf8")).toBe("source bytes\n");
    expect(await present(source)).toBe(false);
  });
});
