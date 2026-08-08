import { Container } from "@earendil-works/pi-tui";
import { copyToClipboard, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../../subagent/types.ts";
import { fullMessageText } from "./session-lines.ts";
import { shell } from "./shell.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

/** Full text of a single history entry, with copy-to-clipboard. */
export class MessageView implements PanelView {
  private readonly ctx: PanelContext;
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
    }
  }

  render(_width: number): Container {
    const theme = this.ctx.theme;
    const snapshot = this.ctx.detailSnapshot();
    const entry = snapshot ? this.currentMessageEntry(snapshot) : undefined;
    if (!entry) return shell(theme, "Message", ["No message"], "esc back");
    const content = fullMessageText(entry);
    const footer = this.copied ? "esc back · c copy · copied" : "esc back · c copy";
    return shell(theme, "Message", content.length > 0 ? [content] : [theme.fg("muted", "(no text content)")], footer);
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
    const snapshot = this.ctx.detailSnapshot();
    if (!snapshot) return;
    const entry = this.currentMessageEntry(snapshot);
    if (!entry) return;
    try {
      await copyToClipboard(fullMessageText(entry));
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
