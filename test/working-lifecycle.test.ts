import { describe, expect, it } from "vitest";
import { StructuredCoordinator } from "../src/subagent/coordinator.ts";

describe("aggregate Working lifecycle", () => {
  it("keeps the root scope pending until an asynchronous descendant's complete subtree settles", async () => {
    let id = 0;
    const coordinator = new StructuredCoordinator(4, { generateId: () => `${++id}`.padStart(8, "0") });
    const child = coordinator.start({ sessionId: "child", agent: "worker", task: "work" });
    const grandchild = coordinator.start({ parentId: child.subagentId, sessionId: "grandchild", agent: "leaf", task: "nested" });
    coordinator.ownLoopEnded(child.subagentId, { state: "finished" });

    const agentEnd = coordinator.waitForDescendants();
    let settled = false;
    void agentEnd.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await coordinator.finish(grandchild.subagentId, { state: "finished" });
    await coordinator.finish(child.subagentId, { state: "finished" });
    await agentEnd;
    expect(settled).toBe(true);
  });
});
