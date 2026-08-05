import { describe, expect, it } from "vitest";
import { renderCompletionMessage } from "../src/presentation.ts";

const theme = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as never;

const notice = {
  agent: "worker",
  state: "finished" as const,
  sessionId: "session-1",
  result: "completed result",
  elapsedMs: 65_000,
};

function rendered(expanded: boolean): string {
  return renderCompletionMessage({ content: "model-visible fallback", details: notice } as never, { expanded, outputPad: 0 } as never, theme)
    .render(120).map((line) => line.trimEnd()).join("\n");
}

describe("subagent completion message renderer", () => {
  it.each(["finished", "failed", "cancelled"] as const)("renders the exact compact %s status", (state) => {
    const component = renderCompletionMessage({ content: "fallback", details: { ...notice, state } } as never, { expanded: false, outputPad: 0 } as never, theme);
    expect(component.render(120).map((line) => line.trimEnd()).join("\n"))
      .toBe(`<toolTitle><b>[subagent]</b></toolTitle>\nSubagent worker ${state} (ctrl+o to expand)`);
  });

  it("adds the result and session identifier only when expanded", () => {
    const output = rendered(true);
    expect(output).toContain("completed result");
    expect(output).toContain("<muted>Session: session-1 · 1m05s</muted>");
  });
});
