import { describe, expect, it, vi } from "vitest";
import { createCompletionMessenger } from "../src/subagent/messenger.ts";

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

const notice = (agent: string) => ({ agent, state: "finished" as const, subagentId: `id-${agent}`, sessionId: `session-${agent}`, result: `${agent} result`, elapsedMs: 10 });

describe("parent messenger delivery", () => {
  it("delivers an idle completion immediately and merges busy-loop completions into one queued message", async () => {
    const { pi, emit } = fakePi();
    const messenger = createCompletionMessenger(pi as never);

    await messenger.send(notice("one"));
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: notice("one") }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await emit("agent_start");
    await messenger.send(notice("two"));
    await messenger.send(notice("three"));
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ details: [notice("two"), notice("three")] }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("starts a new batch after the queued completion message is inserted", async () => {
    const { pi, emit } = fakePi();
    const messenger = createCompletionMessenger(pi as never);
    await emit("agent_start");
    await messenger.send(notice("one"));
    const details = vi.mocked(pi.sendMessage).mock.calls[0]![0].details;
    await emit("message_start", { message: { role: "custom", customType: "subagent", details } });
    await messenger.send(notice("two"));
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("queues completions from awaited agent_end handlers as follow-ups", async () => {
    const { pi, emit } = fakePi();
    const messenger = createCompletionMessenger(pi as never);
    await emit("agent_start");
    await emit("agent_end");
    await messenger.send(notice("one"));
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: [notice("one")] }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("does not release a fast completion until the matching subagent tool-result message is persisted", async () => {
    const { pi, emit } = fakePi();
    const messenger = createCompletionMessenger(pi as never);
    let committed = false;
    void messenger.waitForStartupCommit("call-1").then(() => { committed = true; });
    await emit("message_end", { message: { role: "toolResult", toolName: "other", toolCallId: "call-1" } });
    expect(committed).toBe(false);
    await emit("message_end", { message: { role: "toolResult", toolName: "subagent", toolCallId: "call-1" } });
    await Promise.resolve();
    expect(committed).toBe(true);
  });
});
