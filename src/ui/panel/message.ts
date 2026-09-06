import { Container, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { copyToClipboard, DynamicBorder, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../../subagent/types.ts";
import { fullMessageText } from "./session-lines.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

interface VisualLine {
  /** Original message line number (1-based), undefined for continuation rows. */
  lineNo?: number;
  text: string;
}

/** Full text of a single history entry in a scrollable viewer, with copy-to-clipboard. */
export class MessageView implements PanelView {
  private readonly ctx: PanelContext;
  private scrollOffset = 0;
  private wrapCache: { width: number; lines: VisualLine[]; gutterWidth: number } | undefined;
  private copied = false;
  private copyTimer?: ReturnType<typeof setTimeout>;

  constructor(ctx: PanelContext) {
    this.ctx = ctx;
  }

  dispose(): void {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = undefined;
  }

  handleInput(data: string): void {
    if (key(data, "escape")) {
      this.ctx.backToDetail();
      return;
    }
    if (data.toLowerCase() === "c") {
      void this.copySelectedMessage();
      return;
    }
    const max = this.maxOffset();
    const page = this.pageSize();
    if (key(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (key(data, "down") || data === "j") {
      this.scrollOffset = Math.min(max, this.scrollOffset + 1);
    } else if (key(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - page);
    } else if (key(data, "pageDown")) {
      this.scrollOffset = Math.min(max, this.scrollOffset + page);
    } else if (key(data, "home")) {
      this.scrollOffset = 0;
    } else if (key(data, "end")) {
      this.scrollOffset = max;
    }
  }

  render(width: number): Container {
    const theme = this.ctx.theme;
    const border = (text: string) => theme.fg("accent", text);
    const container = new Container();
    container.addChild(new DynamicBorder(border));
    container.addChild(new Text(theme.fg("accent", theme.bold("Message")), 1, 0));

    const content = this.currentContent();
    const view = content !== undefined && content.length > 0
      ? this.visualLines(content, width)
      : undefined;
    if (view === undefined) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", content === undefined ? "No message" : "(no text content)"), 1, 0));
    } else {
      const { lines, gutterWidth } = view;
      const page = this.pageSize();
      this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset());
      const visible = lines.slice(this.scrollOffset, this.scrollOffset + page);
      // Right-aligned line number + " │ " separator, sized to the message's line count
      const body = visible.map(({ lineNo, text }) => {
        const gutter = lineNo !== undefined ? String(lineNo).padStart(gutterWidth, " ") : " ".repeat(gutterWidth);
        return `${theme.fg("dim", `${gutter} │ `)}${text}`;
      });
      container.addChild(new Spacer(1));
      container.addChild(new Text(body.join("\n"), 0, 0));
    }

    container.addChild(new Spacer(1));
    if (view !== undefined && view.lines.length > this.pageSize()) {
      const end = Math.min(this.scrollOffset + this.pageSize(), view.lines.length);
      container.addChild(new Text(theme.fg("accent", `lines ${this.scrollOffset + 1}-${end} of ${view.lines.length}`), 1, 0));
    }
    const footer = this.copied ? "esc back · c copy · copied" : "esc back · c copy";
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));
    container.addChild(new DynamicBorder(border));
    return container;
  }

  private pageSize(): number {
    // Reserve rows for borders, title, blank spacers, footer and the main UI.
    return Math.max(5, this.ctx.terminalRows - 14);
  }

  private visualLines(content: string, width: number): { lines: VisualLine[]; gutterWidth: number } {
    if (this.wrapCache?.width === width) {
      return { lines: this.wrapCache.lines, gutterWidth: this.wrapCache.gutterWidth };
    }
    const rawLines = content.split("\n");
    const gutterWidth = Math.max(1, String(rawLines.length).length);
    // Body rows are gutter + " │ " + text; keep 2 columns spare so the Text
    // wrapper never re-wraps them.
    const wrapWidth = Math.max(20, width - gutterWidth - 5);
    const lines: VisualLine[] = [];
    rawLines.forEach((raw, index) => {
      wrapTextWithAnsi(raw, wrapWidth).forEach((text, part) => {
        lines.push({ lineNo: part === 0 ? index + 1 : undefined, text });
      });
    });
    this.wrapCache = { width, lines, gutterWidth };
    return { lines, gutterWidth };
  }

  private maxOffset(): number {
    const content = this.currentContent();
    if (content === undefined || content.length === 0) return 0;
    const width = this.wrapCache?.width ?? 80;
    return Math.max(0, this.visualLines(content, width).lines.length - this.pageSize());
  }

  private currentContent(): string | undefined {
    const snapshot = this.ctx.detailSnapshot();
    const entry = snapshot ? this.currentMessageEntry(snapshot) : undefined;
    return entry ? fullMessageText(entry) : undefined;
  }

  private currentMessageEntry(snapshot: SubagentSnapshot): SessionTreeNode["entry"] | undefined {
    const selectedEntryId = this.ctx.selectedEntryId();
    if (!selectedEntryId) return undefined;
    const roots = this.ctx.getTree(snapshot.subagentId) ?? [];
    let found: SessionTreeNode["entry"] | undefined;
    const visit = (nodes: readonly SessionTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.entry.id === selectedEntryId) {
          found = node.entry;
          return true;
        }
        if (visit(node.children)) return true;
      }
      return false;
    };
    visit(roots);
    return found;
  }

  private async copySelectedMessage(): Promise<void> {
    const content = this.currentContent();
    if (content === undefined) return;
    try {
      await copyToClipboard(content);
      this.copied = true;
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copied = false;
        if (this.ctx.isCurrent(this)) this.ctx.requestRender();
      }, 1_500);
    } catch {
      this.copied = false;
    }
  }
}
