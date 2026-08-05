/**
 * Simulate the real subagent tool rendering pipeline.
 *
 * Uses the actual pi `ToolExecutionComponent` (Box + bg shell), the real
 * catppuccin-mocha Theme, the ui-shell tool-indicator patch logic, and
 * cooperate's own renderCall/renderResult.
 *
 * Run: node scripts/simulate-render.ts
 * Output: terminal text + scripts/render-preview.html (colors)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { truncateToWidth } from "@earendil-works/pi-tui";

const GLOBAL_PI =
  "/home/nostalfinals/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent";
const THEME_PATH = "/home/nostalfinals/.pi/agent/themes/catppuccin-mocha.json";
const WIDTH = 100;

const { loadThemeFromPath, setThemeInstance } = await import(
  pathToFileURL(`${GLOBAL_PI}/dist/modes/interactive/theme/theme.js`).href
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(`${GLOBAL_PI}/dist/modes/interactive/components/tool-execution.js`).href
);
const { createAllToolDefinitions } = await import(
  pathToFileURL(`${GLOBAL_PI}/dist/core/tools/index.js`).href
);
const { renderCall, renderResult, setToolDefinitionProvider } = await import("../src/tool/renderer.ts");

const theme = loadThemeFromPath(THEME_PATH, "truecolor");
// The Box shell uses the module-level theme proxy; point it at catppuccin.
setThemeInstance(theme);
const builtinToolDefs = createAllToolDefinitions("/home/nostalfinals/Projects/cooperate");
setToolDefinitionProvider((_subagentId, toolName) => builtinToolDefs[toolName]);

// ---------------------------------------------------------------------------
// ui-shell tool-indicator patch logic (copied from ~/.pi/agent/extensions/ui-shell)
// ---------------------------------------------------------------------------
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;
const SGR_SEQUENCE = /\x1b\[([0-9;:]*)m/g;

function stripAnsi(text: string) {
  return text.replace(ANSI_SEQUENCE, "");
}

function firstVisibleContentIndex(text: string) {
  for (let index = 0; index < text.length; ) {
    if (text[index] === "\x1b") {
      ANSI_SEQUENCE.lastIndex = index;
      const match = ANSI_SEQUENCE.exec(text);
      if (match?.index === index) {
        index += match[0].length;
        continue;
      }
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    if (!/\s/u.test(character)) return index;
    index += character.length;
  }
  return -1;
}

function activeSgrAt(text: string, index: number) {
  const sequences = [...text.slice(0, index).matchAll(SGR_SEQUENCE)];
  let lastReset = -1;
  sequences.forEach((sequence, sequenceIndex) => {
    if (sequence[1] === "" || sequence[1] === "0") lastReset = sequenceIndex;
  });
  return sequences.slice(lastReset + 1).map((s) => s[0]).join("");
}

function toolParameterAnsi(t: typeof theme): string {
  const json = JSON.parse(readFileSync(t.sourcePath, "utf8")) as {
    vars?: Record<string, string | number>;
  };
  const vars = json.vars ?? {};
  let value: string | number | undefined = vars.toolParameter;
  const visited = new Set<string>();
  while (typeof value === "string" && value !== "" && !value.startsWith("#")) {
    if (visited.has(value) || !(value in vars)) {
      value = undefined;
      break;
    }
    visited.add(value);
    value = vars[value];
  }
  if (typeof value !== "string" || !value.startsWith("#")) return "\x1b[39m";
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function withIndicator(lines: string[], pending: boolean, isError: boolean): string[] {
  if (lines.length === 0) return lines;
  const indicator = pending
    ? theme.fg("accent", SPINNER_FRAMES[0]!)
    : isError
      ? theme.fg("error", "×")
      : theme.fg("success", "✓");
  const accentAnsi = theme.getFgAnsi("accent");
  const parameterAnsi = toolParameterAnsi(theme).replace(/\x1b\[39m$/u, "");
  const titleLine = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
  if (titleLine < 0) return lines;
  let line = lines[titleLine]!;
  line = line.split(accentAnsi).join(parameterAnsi);
  const contentIndex = firstVisibleContentIndex(line);
  if (contentIndex < 0) return lines;
  const restoredStyle = activeSgrAt(line, contentIndex);
  lines[titleLine] = truncateToWidth(
    `${line.slice(0, contentIndex)}${indicator}${restoredStyle} ${line.slice(contentIndex)}`,
    WIDTH,
    "",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Mock data (realistic shapes)
// ---------------------------------------------------------------------------
const S1 = "01JX9k2f4m8hK2aQw7vB3cDe";
const S2 = "01JX9k2f4m8hK2aQw7vB3cDf";
const S3 = "01JX9k2f4m8hK2aQw7vB3cDg";
const S4 = "01JX9k2f4m8hK2aQw7vB3cDh";

const runningTree = {
  subagentId: "3f9a2c1d",
  agent: "general",
  sessionId: S1,
  task: "Refactor the checkout flow to support gift cards and promo codes end-to-end",
  model: "deepseek-v4-flash",
  thinking: "max",
  depth: 0,
  startedAt: Date.now() - 12_400,
  elapsedMs: 12_400,
  state: "running",
  children: [
    {
      subagentId: "a7b3e901",
      agent: "worker",
      sessionId: S2,
      task: "Implement the gift card redemption API with balance checks",
      model: "deepseek-v4-flash",
      thinking: "max",
      depth: 1,
      startedAt: Date.now() - 4_300,
      elapsedMs: 4_300,
      state: "running",
      activity: { toolName: "bash", input: { command: "./gradlew :checkout:test" } },
      children: [
        {
          subagentId: "f0c8d2aa",
          agent: "helper",
          sessionId: S3,
          task: "Write unit tests for redemption edge cases",
          model: "deepseek-v4-flash",
          thinking: "low",
          depth: 2,
          startedAt: Date.now() - 2_100,
          elapsedMs: 2_100,
          state: "finished",
          children: [],
        },
      ],
    },
    {
      subagentId: "b2d4f810",
      agent: "helper",
      sessionId: S4,
      task: "Update the checkout UI copy for gift card entry",
      model: "deepseek-v4-flash",
      thinking: "low",
      depth: 1,
      startedAt: Date.now() - 8_900,
      elapsedMs: 8_900,
      state: "finished",
      children: [],
    },
  ],
};

const finishedTree = {
  ...runningTree,
  elapsedMs: 18_600,
  state: "finished",
  children: runningTree.children.map((child) =>
    child.subagentId === "a7b3e901"
      ? { ...child, elapsedMs: 11_200, state: "finished" }
      : child,
  ),
};

const runResultText =
  "Done. The checkout flow now supports gift cards and promo codes:\n\n" +
  "- Added `applyGiftCard` to the checkout service with balance validation\n" +
  "- Wired promo code stacking with gift cards\n" +
  "- All 24 tests pass, including redemption edge cases";

const discoveryText =
  "Available subagent definitions:\n\n" +
  "- general: A general-purpose subagent\n" +
  "- worker: A focused implementation worker subagent\n" +
  "- helper: A small helper subagent for quick tasks";

const subagentsJson = JSON.stringify(
  [
    {
      subagentId: "a7b3e901",
      agent: "worker",
      session: S2,
      task: "Implement the gift card redemption API with balance checks",
      state: "running",
      elapsedMs: 4300,
    },
    {
      subagentId: "b2d4f810",
      agent: "helper",
      session: S4,
      task: "Update the checkout UI copy for gift card entry",
      state: "finished",
      elapsedMs: 8900,
    },
  ],
  null,
  2,
);

const sessionsJson = JSON.stringify(
  [
    {
      session: S2,
      locked: true,
      task: "Implement the gift card redemption API with balance checks",
      result: "Implemented gift card redemption API...",
      file: "/home/nostalfinals/.pi/agent/cooperate/sessions/01JX9k2f4m8hK2aQw7vB3cDf.jsonl",
    },
    {
      session: S4,
      locked: false,
      task: "Update the checkout UI copy for gift card entry",
      result: "Updated checkout UI copy.",
      file: "/home/nostalfinals/.pi/agent/cooperate/sessions/01JX9k2f4m8hK2aQw7vB3cDh.jsonl",
    },
  ],
  null,
  2,
);

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
const ui = { requestRender: () => {} };
let callId = 0;

interface Scenario {
  title: string;
  args: Record<string, unknown>;
  result?: { content: { type: string; text?: string }[]; details?: Record<string, unknown> };
  partial?: boolean;
  expanded?: boolean;
  error?: boolean;
}

function runScenario(scenario: Scenario) {
  const toolDef = { name: "subagent", label: "subagent", renderCall, renderResult };
  const comp = new ToolExecutionComponent(
    "subagent",
    `call_${++callId}`,
    scenario.args,
    { showImages: false },
    toolDef,
    ui,
    "/home/nostalfinals/Projects/cooperate",
  );
  if (scenario.result !== undefined) {
    comp.updateResult(scenario.result, scenario.partial ?? false);
  }
  comp.setExpanded(scenario.expanded ?? false);
  const raw = comp.render(WIDTH);
  const lines = withIndicator(raw, scenario.partial ?? scenario.result === undefined, scenario.error ?? false);
  return { title: scenario.title, lines };
}

const scenarios: Scenario[] = [
  {
    title: "1. run 执行中（折叠）",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow..." },
    result: { content: [], details: { action: "run", async: false, subagentId: "3f9a2c1d", sessionId: S1, snapshot: runningTree } },
    partial: true,
  },
  {
    title: "2. run 执行中（展开）",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow..." },
    result: { content: [], details: { action: "run", async: false, subagentId: "3f9a2c1d", sessionId: S1, snapshot: runningTree } },
    partial: true,
    expanded: true,
  },
  {
    title: "3. run 完成（折叠）",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow..." },
    result: { content: [{ type: "text", text: runResultText }], details: { action: "run", async: false, subagentId: "3f9a2c1d", sessionId: S1, snapshot: finishedTree } },
  },
  {
    title: "4. run 完成（展开，不再显示 result 全文）",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow..." },
    result: { content: [{ type: "text", text: runResultText }], details: { action: "run", async: false, subagentId: "3f9a2c1d", sessionId: S1, snapshot: finishedTree } },
    expanded: true,
  },
  {
    title: "5. run async 成功（不显示 started）",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow...", async: true },
    result: { content: [], details: { action: "run", async: true, subagentId: "3f9a2c1d", sessionId: S1, snapshot: finishedTree } },
  },
  {
    title: "6. run async 失败",
    args: { action: "run", agent: "general", task: runningTree.task, prompt: "Refactor the checkout flow...", async: true },
    result: {
      content: [{ type: "text", text: "Session 01JX9k2f4m8hK2aQw7vB3cDe is locked" }],
      details: { action: "run", async: true },
      isError: true,
    },
    error: true,
  },
  {
    title: "7. list-definitions（2 个）",
    args: { action: "list-definitions" },
    result: { content: [{ type: "text", text: discoveryText }], details: { action: "list-definitions", count: 2 } },
  },
  {
    title: "8. list-definitions（空，展开也不变）",
    args: { action: "list-definitions" },
    result: { content: [{ type: "text", text: "No subagent is defined yet" }], details: { action: "list-definitions", count: 0 } },
    expanded: true,
  },
  {
    title: "9. list-subagents（2 条）",
    args: { action: "list-subagents" },
    result: { content: [{ type: "text", text: subagentsJson }], details: { action: "list-subagents", count: 2 } },
  },
  {
    title: "10. list-subagents（空）",
    args: { action: "list-subagents" },
    result: { content: [{ type: "text", text: "[]" }], details: { action: "list-subagents", count: 0 } },
  },
  {
    title: "11. list-sessions（2 条）",
    args: { action: "list-sessions" },
    result: { content: [{ type: "text", text: sessionsJson }], details: { action: "list-sessions", count: 2 } },
  },
  {
    title: "12. list-sessions（空）",
    args: { action: "list-sessions" },
    result: { content: [{ type: "text", text: "[]" }], details: { action: "list-sessions", count: 0 } },
  },
  {
    title: "13. wait 执行中（折叠）",
    args: { action: "wait", subagentIds: ["a7b3e901", "b2d4f810"] },
    result: {
      content: [],
      details: {
        action: "wait",
        snapshots: [
          { ...runningTree.children[0], elapsedMs: 4_300 },
          { ...runningTree.children[1], elapsedMs: 8_900 },
        ],
      },
    },
    partial: true,
  },
  {
    title: "14. wait 执行中（展开）",
    args: { action: "wait", subagentIds: ["a7b3e901", "b2d4f810"] },
    result: {
      content: [],
      details: {
        action: "wait",
        snapshots: [
          { ...runningTree.children[0], elapsedMs: 4_300 },
          { ...runningTree.children[1], elapsedMs: 8_900 },
        ],
      },
    },
    partial: true,
    expanded: true,
  },
  {
    title: "15. wait 完成（折叠）",
    args: { action: "wait", subagentIds: ["a7b3e901", "b2d4f810"] },
    result: {
      content: [{ type: "text", text: "wait complete" }],
      details: {
        action: "wait",
        snapshots: [
          { ...finishedTree.children[0], elapsedMs: 11_200 },
          { ...finishedTree.children[1], elapsedMs: 8_900 },
        ],
      },
    },
  },
  {
    title: "16. cancel 完成",
    args: { action: "cancel", subagentId: "a7b3e901" },
    result: {
      content: [],
      details: {
        action: "cancel",
        snapshot: { ...finishedTree.children[0], state: "cancelled", reason: "explicitly cancelled", elapsedMs: 4_300 },
      },
    },
  },
];

const rendered = scenarios.map(runScenario);

// ---------------------------------------------------------------------------
// Output: plain text
// ---------------------------------------------------------------------------
console.log("=".repeat(70));
for (const { title, lines } of rendered) {
  console.log(`\n### ${title}`);
  for (const line of lines) {
    console.log(stripAnsi(line).replace(/\s+$/u, ""));
  }
}

// ---------------------------------------------------------------------------
// Output: HTML with true colors
// ---------------------------------------------------------------------------
function esc(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(line: string): string {
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  const push = (text: string) => {
    if (!text) return;
    const styles: string[] = [];
    if (bold) styles.push("font-weight:bold");
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    out += styles.length ? `<span style="${styles.join(";")}">${esc(text)}</span>` : esc(text);
  };
  for (const m of line.matchAll(re)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1];
    if (codes === "" || codes === "0") {
      fg = undefined;
      bg = undefined;
      bold = false;
      continue;
    }
    const parts = codes.split(";");
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i]!;
      if (c === "1") bold = true;
      else if (c === "38" && parts[i + 1] === "2") {
        fg = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
        i += 4;
      } else if (c === "48" && parts[i + 1] === "2") {
        bg = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
        i += 4;
      }
    }
  }
  push(line.slice(last));
  return out;
}

const sections = rendered
  .map(
    ({ title, lines }) =>
      `<h3 style="margin:28px 0 6px;color:#a6adc8;font-family:ui-monospace,monospace;font-size:13px">${esc(title)}</h3>` +
      `<div style="background:#1e1e2e;border:1px solid #313244;border-radius:8px;padding:10px 12px;overflow-x:auto">` +
      lines.map((line) => `<div style="white-space:pre;font-family:'Cascadia Code','Cascadia Mono','JetBrains Mono',Consolas,ui-monospace,monospace;font-size:13px;line-height:1.5">${line === "" ? "\u00A0" : ansiToHtml(line)}</div>`).join("") +
      `</div>`,
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>subagent tool render preview</title></head>
<body style="background:#11111b;margin:0;padding:24px">
<h2 style="color:#cdd6f4;font-family:ui-monospace,monospace">subagent tool · 真实渲染管线模拟（catppuccin-mocha, 100 列）</h2>
${sections}
</body></html>`;

writeFileSync(new URL("./render-preview.html", import.meta.url), html);
console.log("\n\nHTML preview written to scripts/render-preview.html");
