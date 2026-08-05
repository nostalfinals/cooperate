import { describe, expect, it, vi } from "vitest";
import { SubagentsOverlay } from "../src/overlay.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as never;

const child = {
  subagentId: "cafebabe", parentId: "deadbeef", agent: "reviewer", sessionId: "session-2", task: "review output",
  model: "openai/gpt", thinking: "medium", depth: 3, startedAt: Date.now() - 2_000, elapsedMs: 2_000, state: "waiting" as const, children: [],
};
const root = {
  subagentId: "deadbeef", agent: "worker", sessionId: "session-1", task: "implement feature",
  model: "anthropic/sonnet", thinking: "high", depth: 2, startedAt: Date.now() - 65_000, elapsedMs: 65_000, state: "running" as const, children: [child],
};

function output(overlay: SubagentsOverlay): string {
  return overlay.render(78).join("\n");
}

describe("/subagents overlay", () => {
  it("navigates the live hierarchy and detail view within a border", () => {
    const overlay = new SubagentsOverlay({ theme, snapshots: () => [root], cancel: vi.fn(), close: vi.fn(), requestRender: vi.fn() });
    const list = output(overlay);
    expect(list).toContain("subagents");
    expect(list).toContain("worker deadbeef running 1m05s implement feature");
    expect(list).toContain("└─ reviewer cafebabe waiting 2s review output");

    overlay.handleInput("\r");
    const detail = output(overlay);
    expect(detail).toContain("anthropic/sonnet");
    expect(detail).toContain("thinking high");
    expect(detail).toContain("Session session-1");
    expect(detail).toContain("depth 2");
    expect(detail).toContain("direct children 1");
    expect(detail).toContain("c cancel subtree   esc back");
  });

  it("defaults cancellation to No, waits for confirmed cancellation, then returns to the list", async () => {
    let roots = [root];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn(async () => { await gate; roots = []; });
    const overlay = new SubagentsOverlay({ theme, snapshots: () => roots, cancel, close: vi.fn(), requestRender: vi.fn() });
    overlay.handleInput("\r");
    overlay.handleInput("c");
    expect(output(overlay)).toContain("[No]  Yes");
    overlay.handleInput("\r");
    expect(cancel).not.toHaveBeenCalled();
    expect(output(overlay)).toContain("c cancel subtree   esc back");

    overlay.handleInput("c");
    overlay.handleInput("right");
    overlay.handleInput("\r");
    expect(cancel).toHaveBeenCalledWith("deadbeef");
    expect(output(overlay)).toContain("cancelling");
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output(overlay)).toContain("No active subagents");
  });

  it("treats a concurrent terminal transition during cancellation as a harmless refresh", async () => {
    let roots = [root];
    const overlay = new SubagentsOverlay({
      theme,
      snapshots: () => roots,
      cancel: vi.fn(async () => { roots = []; throw new Error("already terminal"); }),
      close: vi.fn(),
      requestRender: vi.fn(),
    });
    overlay.handleInput("\r");
    overlay.handleInput("c");
    overlay.handleInput("right");
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output(overlay)).toContain("No active subagents");
  });

  it("closes from the list on Escape", () => {
    const close = vi.fn();
    const overlay = new SubagentsOverlay({ theme, snapshots: () => [root], cancel: vi.fn(), close, requestRender: vi.fn() });
    overlay.handleInput("\u001b");
    expect(close).toHaveBeenCalledOnce();
  });
});
