import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompletionMessenger } from "../src/subagent/messenger.ts";

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let idle = true;
  const pi = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    sendMessage: vi.fn(),
  };
  const ctx = { isIdle: () => idle };
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { pi, emit, setIdle: (value: boolean) => { idle = value; } };
}

const notice = (agent: string) => ({ agent, state: "finished" as const, subagentId: `id-${agent}`, sessionId: `session-${agent}`, result: `${agent} result`, elapsedMs: 10 });

afterEach(() => vi.useRealTimers());

describe("parent messenger delivery", () => {
  it("holds busy-loop completions until agent_end and delivers them as one follow-up", async () => {
    const { pi, emit, setIdle } = fakePi();
    const messenger = createCompletionMessenger(pi as never);
    setIdle(false);
    await emit("agent_start");

    await Promise.all([messenger.send(notice("one")), messenger.send(notice("two")), messenger.send(notice("three"))]);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await emit("agent_end");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: [notice("one"), notice("two"), notice("three")] }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("coalesces idle completions before starting their follow-up turn", async () => {
    vi.useFakeTimers();
    const { pi } = fakePi();
    const messenger = createCompletionMessenger(pi as never);

    await Promise.all([messenger.send(notice("one")), messenger.send(notice("two")), messenger.send(notice("three"))]);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: [notice("one"), notice("two"), notice("three")] }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("holds completions that arrive during a completion follow-up for its agent_end", async () => {
    vi.useFakeTimers();
    const { pi, emit, setIdle } = fakePi();
    const messenger = createCompletionMessenger(pi as never);

    await messenger.send(notice("one"));
    await vi.advanceTimersByTimeAsync(250);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    setIdle(false);
    await emit("agent_start");
    await Promise.all([messenger.send(notice("two")), messenger.send(notice("three"))]);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await emit("agent_end");
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ details: [notice("two"), notice("three")] }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("delivers reminders model-visibly but never user-rendered, steering while streaming and following up when idle", async () => {
    const { pi, emit, setIdle } = fakePi();
    const messenger = createCompletionMessenger(pi as never);
    const reminder = { text: "progress", subagentIds: ["id-one"] };

    await messenger.sendReminder(reminder);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-reminder", display: false, details: reminder }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    setIdle(false);
    await emit("agent_start");
    await messenger.sendReminder(reminder);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: false }),
      { deliverAs: "steer", triggerTurn: true },
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
