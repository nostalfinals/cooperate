import { describe, expect, it, vi } from "vitest";
import { createPiContinuationHost } from "../src/subagent/continuation.ts";

function fakePi() {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const pi = {
    on: vi.fn((name: string, handler: (event: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    sendMessage: vi.fn(),
  };
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event);
  };
  return { pi, emit };
}

const notice = (agent: string) => ({ agent, state: "finished" as const, sessionId: `session-${agent}`, result: `${agent} result`, elapsedMs: 10 });

describe("parent continuation delivery", () => {
  it("uses steer before logical end, followUp while agent_end is waiting, and keeps simultaneous completions independent", async () => {
    const { pi, emit } = fakePi();
    const host = createPiContinuationHost(pi as never);
    await emit("agent_start");
    await host.send(notice("one"));
    await host.send(notice("two"));
    expect(pi.sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ customType: "cooperate.subagent-completion" }), { deliverAs: "steer", triggerTurn: true });
    expect(pi.sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: expect.stringContaining("two result") }), { deliverAs: "steer", triggerTurn: true });

    await emit("agent_end");
    await host.send(notice("three"));
    expect(pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("three result") }), { deliverAs: "followUp", triggerTurn: true });
  });

  it("does not release a fast completion until the matching subagent tool-result message is persisted", async () => {
    const { pi, emit } = fakePi();
    const host = createPiContinuationHost(pi as never);
    let committed = false;
    void host.waitForStartupCommit("call-1").then(() => { committed = true; });
    await emit("message_end", { message: { role: "toolResult", toolName: "other", toolCallId: "call-1" } });
    expect(committed).toBe(false);
    await emit("message_end", { message: { role: "toolResult", toolName: "subagent", toolCallId: "call-1" } });
    await Promise.resolve();
    expect(committed).toBe(true);
  });
});
