/**
 * Render the DESIGN SPEC for the subagent tool UI (not the current implementation).
 * Outputs scripts/design-preview.html with true catppuccin-mocha colors.
 *
 * Run: bun scripts/design-preview.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

// 模式：
//   （无参数）letter + ui-shell indicator → design-preview.html
//   mark                                → design-preview-mark.html
//   default                             → 模拟不装 ui-shell（无 indicator，字母对齐）
const MODE = process.argv[2] ?? "letter";
const NO_UI_SHELL = MODE === "default";
const ALIGN = MODE === "mark" ? "mark" : "letter";
const OUT = NO_UI_SHELL
  ? "design-preview-default.html"
  : ALIGN === "letter"
    ? "design-preview.html"
    : "design-preview-mark.html";

const THEME = JSON.parse(
  readFileSync("/home/nostalfinals/.pi/agent/themes/catppuccin-mocha.json", "utf8"),
) as { colors: Record<string, string | number>; vars: Record<string, string | number> };
const vars = THEME.vars;

function resolveRole(name: string): string {
  let v: string | number = THEME.colors[name] ?? vars[name]!;
  const seen = new Set<string>();
  while (typeof v === "string" && v !== "" && !v.startsWith("#")) {
    if (seen.has(v)) break;
    seen.add(v);
    v = vars[v]!;
  }
  return typeof v === "string" && v.startsWith("#") ? v : "#ffffff";
}
function resolveVar(name: string): string {
  let v: string | number = vars[name]!;
  const seen = new Set<string>();
  while (typeof v === "string" && v !== "" && !v.startsWith("#")) {
    if (seen.has(v)) break;
    seen.add(v);
    v = vars[v]!;
  }
  return typeof v === "string" && v.startsWith("#") ? v : "#ffffff";
}

const C = {
  toolTitle: resolveRole("toolTitle"),
  toolParameter: resolveVar("toolParameter"),
  accent: resolveRole("accent"),
  muted: resolveRole("muted"),
  dim: resolveRole("dim"),
  success: resolveRole("success"),
  error: resolveRole("error"),
  warning: resolveRole("warning"),
};

const fg = (text: string, hex: string) => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

// role shortcuts
const T = (s: string) => fg(s, C.toolTitle); // toolTitle (near-white)
const P = (s: string) => fg(s, C.toolParameter); // toolParameter (gray)
const A = (s: string) => fg(s, C.accent); // accent (maroon/pink)
const M = (s: string) => fg(s, C.muted); // muted (gray-blue)
const S = (s: string) => fg(s, C.success);
const E = (s: string) => fg(s, C.error);
const W = (s: string) => fg(s, C.warning);

// ---- building blocks -------------------------------------------------------
// 有 ui-shell 时标题行前有 indicator（⠋/✓/×），subagent 的 s 在列 2；
// 无 ui-shell 时无 indicator，s 在列 0。letter 规则下树对齐 s。
const title = (action: string, agent = "", asyncSuffix = false) =>
  (NO_UI_SHELL ? "" : A("⠋") + " ") + T(bold("subagent")) + " " + P(action + (agent ? " " + agent : "")) +
  (asyncSuffix ? M(" (async)") : "");
const titleDone = (action: string, agent = "", asyncSuffix = false) =>
  (NO_UI_SHELL ? "" : S("✓") + " ") + T(bold("subagent")) + " " + P(action + (agent ? " " + agent : "")) +
  (asyncSuffix ? M(" (async)") : "");
const titleError = (action: string, agent = "", asyncSuffix = false) =>
  (NO_UI_SHELL ? "" : E("×") + " ") + T(bold("subagent")) + " " + P(action + (agent ? " " + agent : "")) +
  (asyncSuffix ? M(" (async)") : "");

type TreeNode = {
  agent: string;
  time: string;
  task: string;
  mark: string;
  activity?: "thinking..." | { tool: string; params: string };
  children?: TreeNode[];
};

/**
 * Tree layout rule: a child's branch column = the parent's agent-name column.
 *   - root:     mark at col 0, agent at col 2  → children branch at col 2
 *   - non-root: branch at col B, mark at B+3, agent at B+5 → children branch at B+5
 * Continuation lines (│) sit at the node's own branch column, muted.
 * Activity lines: → aligned to the node's mark column.
 */
function nodeLine(node: TreeNode, branchCol: number, isLast: boolean): string {
  const body = node.mark + " " + A(node.agent) + " " + M(`${node.time} · ${node.task}`);
  if (branchCol < 0) return body; // root: mark at col 0
  return " ".repeat(branchCol) + M(isLast ? "└─" : "├─") + " " + body;
}

function activityLine(node: TreeNode, branchCol: number, isLast: boolean): string {
  if (!node.activity) return "";
  const markCol = branchCol < 0 ? 0 : branchCol + 3;
  const cont =
    branchCol < 0 || isLast
      ? " ".repeat(markCol)
      : " ".repeat(branchCol) + M("│") + " ".repeat(markCol - branchCol - 1);
  if (node.activity === "thinking...") return cont + A("→") + " " + M("thinking...");
  return cont + A("→") + " " + T(node.activity.tool) + " " + M(node.activity.params);
}

function renderChildren(nodes: TreeNode[], branchCol: number, parentBranchCol: number): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    if (parentBranchCol >= 0) {
      lines.push(
        " ".repeat(parentBranchCol) + M("│") + " ".repeat(branchCol - parentBranchCol - 1) +
          M(isLast ? "└─" : "├─") + " " + node.mark + " " + A(node.agent) + " " +
          M(`${node.time} · ${node.task}`),
      );
    } else {
      lines.push(nodeLine(node, branchCol, isLast));
    }
    if (node.activity) lines.push(activityLine(node, branchCol, isLast));
    if (node.children?.length) {
      lines.push(...renderChildren(node.children, ALIGN === "mark" ? branchCol + 3 : branchCol + 5, branchCol));
    }
  });
  return lines;
}

function renderRootLines(node: TreeNode): string[] {
  const lines = [nodeLine(node, -1, true)];
  if (node.activity) lines.push(activityLine(node, -1, true));
  if (node.children?.length) lines.push(...renderChildren(node.children, ALIGN === "mark" ? 0 : 2, -1));
  return lines;
}

// ---- scenes -----------------------------------------------------------------
interface Scene {
  title: string;
  note?: string;
  lines: string[];
}

const HINT_SHOW = M("(ctrl+o to show activity)");
const HINT_HIDE = M("(ctrl+o to hide activity)");

const spinner = A("⠋");
const done = S("✓");
const cancelled = W("–");

const generalTask = "Refactor the checkout flow to support gift cards and promo codes end-to-end";
const workerTask = "Implement the gift card redemption API with balance checks";
const helperTask = "Write unit tests for redemption edge cases";
const copyTask = "Update the checkout UI copy for gift card entry";
const researcherTask = "Lookup React useState documentation using Context7";

const scenes: Scene[] = [];

const generalRunning: TreeNode = {
  agent: "general",
  time: "12s",
  task: generalTask,
  mark: spinner,
  children: [
    {
      agent: "worker",
      time: "4s",
      task: workerTask,
      mark: spinner,
      children: [{ agent: "helper", time: "2s", task: helperTask, mark: done }],
    },
    { agent: "helper", time: "1m 12s", task: copyTask, mark: done },
  ],
};
const generalDone: TreeNode = {
  ...generalRunning,
  mark: done,
  children: [
    { ...generalRunning.children![0]!, mark: done },
    { ...generalRunning.children![1]!, mark: done },
  ],
};
const researcher = { agent: "researcher", time: "3s", task: researcherTask, mark: spinner };

// 1. run 执行中（折叠）
scenes.push({
  title: "1. run 执行中（折叠）",
  lines: [
    title("run", "general"),
    "",
    ...renderRootLines(generalRunning),
    ...renderRootLines(researcher),
    "",
    HINT_SHOW,
  ],
});

// 2. run 执行中（展开）
scenes.push({
  title: "2. run 执行中（展开）",
  lines: [
    title("run", "general"),
    "",
    ...renderRootLines({
      ...generalRunning,
      activity: "thinking...",
      children: [
        {
          ...generalRunning.children![0]!,
          activity: { tool: "bash", params: "./gradlew :checkout:test" },
        },
        generalRunning.children![1]!,
      ],
    }),
    ...renderRootLines({ ...researcher, activity: "thinking..." }),
    "",
    HINT_HIDE,
  ],
  note: "已完成节点不显示 activity；researcher 的 activity 是按规则补的（demo 未画）",
});

// 3. run 完成（折叠）
scenes.push({
  title: "3. run 完成（折叠）",
  lines: [
    titleDone("run", "general"),
    "",
    ...renderRootLines(generalDone),
    ...renderRootLines({ ...researcher, mark: done }),
    "",
    HINT_SHOW,
  ],
});

// 4. run 完成（展开）
scenes.push({
  title: "4. run 完成（展开）",
  lines: [
    titleDone("run", "general"),
    "",
    ...renderRootLines(generalDone),
    ...renderRootLines({ ...researcher, mark: done }),
    "",
    HINT_HIDE,
  ],
  note: "展开不再显示 result 全文，所以完成态展开/折叠视觉一致，提示词保留",
});

// 5. run async 成功
scenes.push({
  title: "5. run async 成功",
  lines: [titleDone("run", "general", true)],
  note: "不再显示 started <id>；Pi 自己的成功/失败背景 + ui-shell indicator 足够",
});

// 6. run async 失败
scenes.push({
  title: "6. run async 失败",
  lines: [titleError("run", "general", true), "", M("Session was occupied")],
  note: "错误原因 muted 展示，不提及 session id；模型拿到的 result 内容中仍有完整错误",
});

// 7. list-definitions（2 个）
scenes.push({
  title: "7. list-definitions（2 个）",
  lines: [titleDone("list-definitions"), "", M("2 definitions")],
});

// 8. list-definitions（空）
scenes.push({
  title: "8. list-definitions（空）",
  lines: [titleDone("list-definitions"), "", M("No subagent is defined yet")],
  note: "list-definitions 不支持展开",
});

// 9. list-subagents（2 个）— 推断文案
scenes.push({
  title: "9. list-subagents（2 个）",
  lines: [titleDone("list-subagents"), "", M("2 active subagents")],
});
// 10. list-subagents（空）— 推断文案
scenes.push({
  title: "10. list-subagents（空）",
  lines: [titleDone("list-subagents"), "", M("No subagent is active yet")],
  note: "空态文案为推断（demo 未给），词性单复数规则同 list-definitions",
});
// 11. list-sessions（2 个）— 推断文案
scenes.push({
  title: "11. list-sessions（2 个）",
  lines: [titleDone("list-sessions"), "", M("2 sessions")],
});
// 12. list-sessions（空）— 推断文案
scenes.push({
  title: "12. list-sessions（空）",
  lines: [titleDone("list-sessions"), "", M("No session yet")],
  note: "空态文案为推断（demo 未给）",
});

// wait/cancel 树从标题行 subagent 的 s 列开始：有 ui-shell 时 s 在列 2（indicator 后），无 ui-shell 时 s 在列 0
const TREE_BASE = NO_UI_SHELL ? 0 : ALIGN === "mark" ? 0 : 2;

// 13. wait 执行中（折叠）— 树从标题行 subagent 的 s（列 2）开始
scenes.push({
  title: "13. wait 执行中（折叠）",
  lines: [
    title("wait"),
    ...renderChildren(
      [
        { agent: "helper", time: "1m 12s", task: copyTask, mark: done },
        { agent: "worker", time: "4s", task: workerTask, mark: spinner },
      ],
      TREE_BASE,
      -1,
    ),
    "",
    HINT_SHOW,
  ],
  note: "标题下不空行，树直接连接；只显示 wait 传入 id 的实际状态，一层结构",
});

// 14. wait 执行中（展开）
scenes.push({
  title: "14. wait 执行中（展开）",
  lines: [
    title("wait"),
    ...renderChildren(
      [
        { agent: "helper", time: "1m 12s", task: copyTask, mark: done },
        {
          agent: "worker",
          time: "4s",
          task: workerTask,
          mark: spinner,
          activity: { tool: "bash", params: "npm check" },
        },
      ],
      TREE_BASE,
      -1,
    ),
    "",
    HINT_HIDE,
  ],
  note: "demo 里已完成的 helper 下画了 thinking... 与规则（完成节点无 activity）矛盾，按规则处理",
});

// 15. wait 完成（折叠）
scenes.push({
  title: "15. wait 完成（折叠）",
  lines: [
    titleDone("wait"),
    ...renderChildren(
      [
        { agent: "helper", time: "1m 12s", task: copyTask, mark: done },
        { agent: "worker", time: "4s", task: workerTask, mark: done },
      ],
      TREE_BASE,
      -1,
    ),
    "",
    HINT_SHOW,
  ],
});

// 16. wait 完成（展开）
scenes.push({
  title: "16. wait 完成（展开）",
  lines: [
    titleDone("wait"),
    ...renderChildren(
      [
        { agent: "helper", time: "1m 12s", task: copyTask, mark: done },
        { agent: "worker", time: "4s", task: workerTask, mark: done },
      ],
      TREE_BASE,
      -1,
    ),
    "",
    HINT_HIDE,
  ],
});

// 17. cancel 执行中
scenes.push({
  title: "17. cancel 执行中",
  lines: [title("cancel"), ...renderChildren([{ agent: "worker", time: "4s", task: workerTask, mark: spinner }], TREE_BASE, -1)],
  note: "cancel 与 wait 同构（单 id → 单节点树）",
});

// 18. cancel 完成
scenes.push({
  title: "18. cancel 完成",
  lines: [titleDone("cancel"), ...renderChildren([{ agent: "worker", time: "4s", task: workerTask, mark: cancelled }], TREE_BASE, -1)],
});

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------
const FONT_FAMILY = "'Cascadia Code','Cascadia Mono','JetBrains Mono',Consolas,ui-monospace,monospace";

function esc(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(line: string): string {
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let fgColor: string | undefined;
  let boldOn = false;
  const push = (text: string) => {
    if (!text) return;
    const styles: string[] = [];
    if (boldOn) styles.push("font-weight:bold");
    if (fgColor) styles.push(`color:${fgColor}`);
    out += styles.length ? `<span style="${styles.join(";")}">${esc(text)}</span>` : esc(text);
  };
  for (const m of line.matchAll(re)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1];
    if (codes === "" || codes === "0") {
      fgColor = undefined;
      boldOn = false;
      continue;
    }
    const parts = codes.split(";");
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i]!;
      if (c === "1") boldOn = true;
      else if (c === "38" && parts[i + 1] === "2") {
        fgColor = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
        i += 4;
      }
    }
  }
  push(line.slice(last));
  return out;
}

const legend = [
  ["toolTitle", C.toolTitle],
  ["toolParameter", C.toolParameter],
  ["accent", C.accent],
  ["muted", C.muted],
  ["success", C.success],
  ["error", C.error],
  ["warning", C.warning],
].map(([name, hex]) => {
  const r = Number.parseInt((hex as string).slice(1, 3), 16);
  const g = Number.parseInt((hex as string).slice(3, 5), 16);
  const b = Number.parseInt((hex as string).slice(5, 7), 16);
  return `<span style="color:rgb(${r},${g},${b})">■</span> ${name}`;
}).join("&nbsp;&nbsp;&nbsp;");

const sections = scenes
  .map((scene) => {
    const note = scene.note ? `<div style="color:#6c7086;font-size:12px;margin-top:6px">※ ${esc(scene.note)}</div>` : "";
    return (
      `<h3 style="margin:26px 0 6px;color:#a6adc8;font-family:${FONT_FAMILY};font-size:13px">${esc(scene.title)}</h3>` +
      `<div style="background:#181825;border:1px solid #313244;border-radius:8px;padding:10px 14px;overflow-x:auto">` +
      scene.lines.map((line) => `<div style="white-space:pre;font-family:${FONT_FAMILY};font-size:13.5px;line-height:1.55">${line === "" ? "\u00A0" : ansiToHtml(line)}</div>`).join("") +
      `</div>${note}`
    );
  })
  .join("\n");

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>subagent tool 设计稿</title></head>
<body style="background:#11111b;margin:0;padding:24px 32px 60px">
<h2 style="color:#cdd6f4;font-family:${FONT_FAMILY};margin-bottom:4px">subagent tool · UI 设计稿</h2>
<div style="color:#6c7086;font-family:${FONT_FAMILY};font-size:12px;margin-bottom:18px">${legend}</div>
${sections}
</body></html>`;

writeFileSync(new URL(OUT, import.meta.url), html);
console.log(`written: ${OUT}`);
