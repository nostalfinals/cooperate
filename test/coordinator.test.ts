import { describe, expect, it, vi } from "vitest";
import { StructuredCoordinator } from "../src/coordinator.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("StructuredCoordinator", () => {
  it("allocates collision-checked transient IDs, enforces global Session locks, and releases both at terminal completion", async () => {
    const ids = ["deadbeef", "deadbeef", "cafebabe"];
    const coordinator = new StructuredCoordinator(3, { generateId: () => ids.shift()! });
    const first = coordinator.start({ parentId: undefined, sessionId: "session-1", agent: "worker", task: "one" });
    expect(first.subagentId).toBe("deadbeef");
    expect(() => coordinator.start({ parentId: undefined, sessionId: "session-1", agent: "worker", task: "locked" })).toThrow("locked");
    const second = coordinator.start({ parentId: undefined, sessionId: "session-2", agent: "worker", task: "two" });
    expect(second.subagentId).toBe("cafebabe");

    await coordinator.finish(first.subagentId, { state: "finished" });
    expect(coordinator.isSessionLocked("session-1")).toBe(false);
    expect(coordinator.get(first.subagentId)).toBeUndefined();
    await coordinator.finish(second.subagentId, { state: "finished" });
  });

  it("tracks depth and running-to-waiting while an own-ended parent still has descendants", async () => {
    let next = 0;
    const coordinator = new StructuredCoordinator(3, { generateId: () => `${++next}`.padStart(8, "0") });
    const parent = coordinator.start({ parentId: undefined, sessionId: "p", agent: "parent", task: "parent task" });
    const child = coordinator.start({ parentId: parent.subagentId, sessionId: "c", agent: "child", task: "child task" });
    expect(parent.depth).toBe(2);
    expect(child.depth).toBe(3);

    coordinator.ownLoopEnded(parent.subagentId, { state: "finished" });
    expect(coordinator.get(parent.subagentId)?.state).toBe("waiting");
    const waiting = coordinator.waitForDescendants(parent.subagentId);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await coordinator.finish(child.subagentId, { state: "finished" });
    await waiting;
    await coordinator.finish(parent.subagentId, { state: "finished" });
    expect(coordinator.snapshotRoots()).toEqual([]);
  });

  it("rejects a child beyond maxDepth before allocating an ID or lock", () => {
    const generateId = vi.fn()
      .mockReturnValueOnce("00000001")
      .mockReturnValueOnce("00000002");
    const coordinator = new StructuredCoordinator(2, { generateId });
    const parent = coordinator.start({ parentId: undefined, sessionId: "p", agent: "parent", task: "task" });
    expect(() => coordinator.start({ parentId: parent.subagentId, sessionId: "c", agent: "child", task: "task" })).toThrow("maxDepth");
    expect(generateId).toHaveBeenCalledOnce();
    expect(coordinator.isSessionLocked("c")).toBe(false);
  });

  it("records resolved model and thinking metadata in snapshots", () => {
    const coordinator = new StructuredCoordinator(3, { generateId: () => "00000001" });
    const node = coordinator.start({ parentId: undefined, sessionId: "p", agent: "worker", task: "task" });
    coordinator.setRuntimeInfo(node.subagentId, { model: "anthropic/claude-sonnet", thinking: "high" });
    expect(coordinator.snapshot(node.subagentId)).toMatchObject({ model: "anthropic/claude-sonnet", thinking: "high" });
  });

  it("returns deeply immutable snapshots that retain completed descendants", async () => {
    const coordinator = new StructuredCoordinator(3, { generateId: (() => { let n = 0; return () => `${++n}`.padStart(8, "0"); })() });
    const parent = coordinator.start({ parentId: undefined, sessionId: "p", agent: "parent", task: "parent" });
    const child = coordinator.start({ parentId: parent.subagentId, sessionId: "c", agent: "child", task: "child" });
    await coordinator.finish(child.subagentId, { state: "finished" });
    const snapshot = coordinator.snapshot(parent.subagentId)!;
    expect(snapshot.children[0]).toMatchObject({ subagentId: child.subagentId, state: "finished" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.children)).toBe(true);
  });
});
