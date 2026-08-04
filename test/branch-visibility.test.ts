import { describe, expect, it } from "vitest";
import { OWNERSHIP_ENTRY, ownedSessionIds } from "../src/sessions.ts";

describe("branch-visible Session ownership", () => {
  it("survives compaction because native custom entries remain on the branch", () => {
    const compactedBranch = [
      { type: "custom", id: "owned", parentId: null, customType: OWNERSHIP_ENTRY, data: { sessionId: "child-before-compaction" } },
      { type: "compaction", id: "summary", parentId: "owned", summary: "older model context was compacted" },
      { type: "message", id: "after", parentId: "summary", message: { role: "user", content: "continue" } },
    ];

    expect(ownedSessionIds(compactedBranch)).toEqual(["child-before-compaction"]);
  });

  it("tracks the active native tree branch instead of treating fork-hidden ownership as global", () => {
    let branch: readonly unknown[] = [
      { type: "custom", customType: OWNERSHIP_ENTRY, data: { sessionId: "left-child" } },
    ];
    const visible = () => ownedSessionIds(branch);
    expect(visible()).toEqual(["left-child"]);

    branch = [{ type: "custom", customType: OWNERSHIP_ENTRY, data: { sessionId: "right-child" } }];
    expect(visible()).toEqual(["right-child"]);
  });
});
