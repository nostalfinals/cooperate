import { describe, expect, it, vi } from "vitest";
import { StructuredCoordinator } from "../../src/subagent/coordinator.ts";

function coordinator() {
  let id = 0;
  return new StructuredCoordinator(4, { generateId: () => `${++id}`.padStart(8, "0") });
}

describe("structured failure and cancellation", () => {
  it("cancels descendants only on a confirmed failure, recursively, while leaving a sibling running", async () => {
    const tree = coordinator();
    const failed = tree.start({ parentId: undefined, sessionId: "failed", agent: "failed", task: "fail" });
    const descendant = tree.start({ parentId: failed.subagentId, sessionId: "descendant", agent: "leaf", task: "work" });
    const grandchild = tree.start({ parentId: descendant.subagentId, sessionId: "grandchild", agent: "leaf", task: "work" });
    const sibling = tree.start({ parentId: undefined, sessionId: "sibling", agent: "sibling", task: "continue" });
    const abortDescendant = vi.fn();
    const abortGrandchild = vi.fn();
    const abortSibling = vi.fn();
    tree.attachAbort(descendant.subagentId, abortDescendant);
    tree.attachAbort(grandchild.subagentId, abortGrandchild);
    tree.attachAbort(sibling.subagentId, abortSibling);

    // A transient agent_end failure (pi may auto-retry) must not kill descendants.
    tree.ownLoopEnded(failed.subagentId, { state: "failed", reason: "fetch failed" });
    expect(abortDescendant).not.toHaveBeenCalled();
    expect(abortGrandchild).not.toHaveBeenCalled();
    expect(abortSibling).not.toHaveBeenCalled();
    expect(tree.get(failed.subagentId)?.state).toBe("waiting");

    // Only the confirmed-failure path cancels the subtree, recursively.
    tree.cancelDescendants(failed.subagentId, "model failed");
    expect(abortDescendant).toHaveBeenCalledOnce();
    expect(abortGrandchild).toHaveBeenCalledOnce();
    expect(abortSibling).not.toHaveBeenCalled();

    await tree.finish(grandchild.subagentId, { state: "cancelled", reason: "model failed" });
    await tree.finish(descendant.subagentId, { state: "cancelled", reason: "model failed" });
    const failedSnapshot = await tree.finish(failed.subagentId, { state: "failed", reason: "model failed" });
    expect(failedSnapshot).toMatchObject({ state: "failed", reason: "fetch failed" });
    expect(failedSnapshot?.children).toEqual([expect.objectContaining({ state: "cancelled" })]);
    expect(tree.get(sibling.subagentId)?.state).toBe("running");
    await tree.finish(sibling.subagentId, { state: "finished" });
  });

  it("keeps descendants running when a recovered parent finishes successfully", async () => {
    const tree = coordinator();
    const parent = tree.start({ parentId: undefined, sessionId: "parent", agent: "parent", task: "work" });
    const child = tree.start({ parentId: parent.subagentId, sessionId: "child", agent: "child", task: "work" });
    const abortChild = vi.fn();
    tree.attachAbort(child.subagentId, abortChild);

    tree.ownLoopEnded(parent.subagentId, { state: "failed", reason: "fetch failed" });
    tree.recoverAsFinished(parent.subagentId);
    tree.cancelDescendants(parent.subagentId, "late failure");
    expect(abortChild).not.toHaveBeenCalled();

    await tree.finish(child.subagentId, { state: "finished" });
    const snapshot = await tree.finish(parent.subagentId, { state: "finished" });
    expect(snapshot).toMatchObject({ state: "finished" });
    expect(snapshot?.children).toEqual([expect.objectContaining({ state: "finished" })]);
  });

  it("keeps root cancellation pending until every targeted scope reports disposal complete", async () => {
    const tree = coordinator();
    const parent = tree.start({ parentId: undefined, sessionId: "parent", agent: "parent", task: "work" });
    const child = tree.start({ parentId: parent.subagentId, sessionId: "child", agent: "child", task: "work" });
    const abortParent = vi.fn();
    const abortChild = vi.fn();
    tree.attachAbort(parent.subagentId, abortParent);
    tree.attachAbort(child.subagentId, abortChild);

    const shutdown = tree.cancelAll("shutdown");
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(abortParent).toHaveBeenCalledOnce();
    expect(abortChild).toHaveBeenCalledOnce();

    await tree.finish(child.subagentId, { state: "cancelled", reason: "shutdown" });
    await tree.finish(parent.subagentId, { state: "cancelled", reason: "shutdown" });
    await shutdown;
    expect(settled).toBe(true);
  });

  it("cancels an applicable subtree, invokes every abort once, and tolerates racing repeated operations", async () => {
    const tree = coordinator();
    const parent = tree.start({ parentId: undefined, sessionId: "parent", agent: "parent", task: "work" });
    const child = tree.start({ parentId: parent.subagentId, sessionId: "child", agent: "child", task: "work" });
    const abortParent = vi.fn();
    const abortChild = vi.fn();
    tree.attachAbort(parent.subagentId, abortParent);
    tree.attachAbort(child.subagentId, abortChild);

    tree.requestCancel(parent.subagentId, "interrupted");
    tree.requestCancel(parent.subagentId, "later reason");
    expect(abortParent).toHaveBeenCalledOnce();
    expect(abortChild).toHaveBeenCalledOnce();

    await tree.finish(child.subagentId, { state: "cancelled", reason: "interrupted" });
    const first = tree.finish(parent.subagentId, { state: "cancelled", reason: "interrupted" });
    const second = tree.finish(parent.subagentId, { state: "failed", reason: "late failure" });
    const [winner, loser] = await Promise.all([first, second]);
    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    expect(winner ?? loser).toMatchObject({ state: "cancelled", reason: "interrupted" });
    await expect(tree.cancelAndWait(parent.subagentId)).resolves.toBeUndefined();
  });
});
