import { describe, expect, it, vi } from "vitest";
import { StructuredCoordinator } from "../src/subagent/coordinator.ts";

function coordinator() {
  let id = 0;
  return new StructuredCoordinator(4, { generateId: () => `${++id}`.padStart(8, "0") });
}

describe("structured failure and cancellation", () => {
  it("cascades a failure vertically while leaving a sibling running", async () => {
    const tree = coordinator();
    const failed = tree.start({ parentId: undefined, sessionId: "failed", agent: "failed", task: "fail" });
    const descendant = tree.start({ parentId: failed.subagentId, sessionId: "descendant", agent: "leaf", task: "work" });
    const sibling = tree.start({ parentId: undefined, sessionId: "sibling", agent: "sibling", task: "continue" });
    const abortDescendant = vi.fn();
    const abortSibling = vi.fn();
    tree.attachAbort(descendant.subagentId, abortDescendant);
    tree.attachAbort(sibling.subagentId, abortSibling);

    tree.ownLoopEnded(failed.subagentId, { state: "failed", reason: "model failed" });
    expect(abortDescendant).toHaveBeenCalledOnce();
    expect(abortSibling).not.toHaveBeenCalled();
    expect(tree.get(failed.subagentId)?.state).toBe("waiting");

    await tree.finish(descendant.subagentId, { state: "cancelled", reason: "ancestor failed" });
    const failedSnapshot = await tree.finish(failed.subagentId, { state: "failed", reason: "model failed" });
    expect(failedSnapshot).toMatchObject({ state: "failed", reason: "model failed" });
    expect(failedSnapshot?.children).toEqual([expect.objectContaining({ state: "cancelled" })]);
    expect(tree.get(sibling.subagentId)?.state).toBe("running");
    await tree.finish(sibling.subagentId, { state: "finished" });
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
