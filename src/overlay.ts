import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./coordinator.ts";
import { formatElapsed, snapshotElapsed } from "./presentation.ts";
import { compactPreview } from "./sessions.ts";

interface OverlayOptions {
  theme: Theme;
  snapshots(): readonly SubagentSnapshot[];
  cancel(subagentId: string): Promise<void>;
  close(): void;
  requestRender(): void;
  onDispose?(): void;
  startTimer?: boolean;
}

interface Row {
  snapshot: SubagentSnapshot;
  prefix: string;
}

function isActive(snapshot: SubagentSnapshot): boolean {
  return snapshot.state === "running" || snapshot.state === "waiting";
}

function rowsFor(roots: readonly SubagentSnapshot[]): Row[] {
  const rows: Row[] = [];
  const visit = (snapshot: SubagentSnapshot, prefix: string): void => {
    if (!isActive(snapshot)) return;
    rows.push({ snapshot, prefix });
    const activeChildren = snapshot.children.filter(isActive);
    activeChildren.forEach((child, index) => visit(child, prefix + (index === activeChildren.length - 1 ? "└─ " : "├─ ")));
  };
  roots.forEach((root) => visit(root, ""));
  return rows;
}

function key(data: string, name: "left" | "right" | "escape"): boolean {
  return data === name || (name === "escape" && data === "\u001b") || matchesKey(data, name);
}

function descendantCount(snapshot: SubagentSnapshot): number {
  return snapshot.children.filter(isActive).reduce((count, child) => count + 1 + descendantCount(child), 0);
}

/** Model-preset-style component backing the `/subagents` command. */
export class SubagentsOverlay implements Component {
  private readonly options: OverlayOptions;
  private mode: "list" | "detail" | "confirm" = "list";
  private selectedId?: string;
  private detailId?: string;
  private list?: SelectList;
  private confirmList?: SelectList;
  private confirmChoice: "no" | "yes" = "no";
  private cancelling = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: OverlayOptions) {
    this.options = options;
    if (options.startTimer) this.timer = setInterval(options.requestRender, 1_000);
  }

  invalidate(): void {
    this.list?.invalidate();
    this.confirmList?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.onDispose?.();
  }

  handleInput(data: string): void {
    if (this.cancelling) return;
    if (this.mode === "list") {
      if (key(data, "escape")) {
        this.dispose();
        this.options.close();
      } else {
        if (!this.list) this.listContainer();
        this.list?.handleInput(data);
      }
    } else if (this.mode === "detail") {
      if (key(data, "escape")) this.showList();
      else if (data.toLowerCase() === "c" && this.currentDetail()) {
        this.confirmChoice = "no";
        this.mode = "confirm";
        this.confirmContainer();
      }
    } else if (key(data, "escape")) {
      this.mode = "detail";
    } else if (key(data, "left")) {
      this.confirmChoice = "no";
      this.confirmList?.setSelectedIndex(0);
    } else if (key(data, "right")) {
      this.confirmChoice = "yes";
      this.confirmList?.setSelectedIndex(1);
    } else {
      this.confirmList?.handleInput(data);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    if (this.mode !== "list" && !this.currentDetail()) this.showList();
    const container = this.mode === "list"
      ? this.listContainer()
      : this.mode === "detail"
        ? this.detailContainer()
        : this.confirmContainer();
    return container.render(width);
  }

  private shell(title: string): Container {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => this.options.theme.fg("accent", text)));
    container.addChild(new Text(this.options.theme.fg("accent", this.options.theme.bold(title)), 1, 0));
    return container;
  }

  private finishShell(container: Container, footer: string): Container {
    container.addChild(new Text(this.options.theme.fg("dim", footer), 1, 0));
    container.addChild(new DynamicBorder((text: string) => this.options.theme.fg("accent", text)));
    return container;
  }

  private listContainer(): Container {
    const container = this.shell("Subagents");
    const rows = rowsFor(this.options.snapshots());
    if (rows.length === 0) {
      this.list = undefined;
      container.addChild(new Text("No active subagents", 1, 0));
      return this.finishShell(container, "esc close");
    }

    const items: SelectItem[] = rows.map(({ snapshot, prefix }) => ({
      value: snapshot.subagentId,
      label: `${prefix}${snapshot.agent} · ${snapshot.state} · ${formatElapsed(snapshotElapsed(snapshot))}`,
      description: compactPreview(snapshot.task, 120),
    }));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => this.options.theme.fg("accent", text),
      selectedText: (text) => this.options.theme.fg("accent", text),
      description: (text) => this.options.theme.fg("muted", text),
      scrollInfo: (text) => this.options.theme.fg("dim", text),
      noMatch: (text) => this.options.theme.fg("warning", text),
    }, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 46,
    });
    const selectedIndex = Math.max(0, items.findIndex((item) => item.value === this.selectedId));
    list.setSelectedIndex(selectedIndex);
    this.selectedId = items[selectedIndex]?.value;
    list.onSelectionChange = (item) => { this.selectedId = item.value; };
    list.onSelect = (item) => {
      this.detailId = item.value;
      this.mode = "detail";
      this.options.requestRender();
    };
    list.onCancel = () => {
      this.dispose();
      this.options.close();
    };
    this.list = list;
    container.addChild(list);
    return this.finishShell(container, "↑↓ navigate • enter details • esc close");
  }

  private detailContainer(): Container {
    const snapshot = this.currentDetail()!;
    const container = this.shell("Subagent Details");
    container.addChild(new Text([
      `${this.options.theme.fg("accent", snapshot.agent)} · ${snapshot.state} · ${formatElapsed(snapshotElapsed(snapshot))}`,
      `task ${snapshot.task}`,
      `model ${snapshot.model ?? "unknown"}`,
      `thinking ${snapshot.thinking ?? "unknown"}`,
      `depth ${snapshot.depth}`,
      `subagent ${snapshot.subagentId}`,
      `Session ${snapshot.sessionId}`,
      `direct children ${snapshot.children.filter(isActive).length}`,
    ].join("\n"), 1, 0));
    return this.finishShell(container, "c cancel subtree   esc back");
  }

  private confirmContainer(): Container {
    const snapshot = this.currentDetail()!;
    const container = this.shell("Cancel Subagent");
    const descendants = descendantCount(snapshot);
    container.addChild(new Text(
      `Cancel ${snapshot.agent} and its ${descendants} descendant${descendants === 1 ? "" : "s"}?`,
      1,
      0,
    ));
    if (this.cancelling) {
      this.confirmList = undefined;
      container.addChild(new Text(this.options.theme.fg("muted", "cancelling…"), 1, 0));
    } else {
      const list = new SelectList([
        { value: "no", label: "No" },
        { value: "yes", label: "Yes" },
      ], 2, {
        selectedPrefix: (text) => this.options.theme.fg("accent", text),
        selectedText: (text) => this.options.theme.fg("accent", text),
        description: (text) => this.options.theme.fg("muted", text),
        scrollInfo: (text) => this.options.theme.fg("dim", text),
        noMatch: (text) => this.options.theme.fg("warning", text),
      });
      list.setSelectedIndex(this.confirmChoice === "yes" ? 1 : 0);
      list.onSelectionChange = (item) => { this.confirmChoice = item.value === "yes" ? "yes" : "no"; };
      list.onSelect = (item) => {
        if (item.value === "no") {
          this.mode = "detail";
          this.options.requestRender();
          return;
        }
        this.cancel(snapshot.subagentId);
      };
      list.onCancel = () => {
        this.mode = "detail";
        this.options.requestRender();
      };
      this.confirmList = list;
      container.addChild(list);
    }
    return this.finishShell(container, "←→ choose • enter confirm • esc back");
  }

  private cancel(subagentId: string): void {
    this.cancelling = true;
    this.options.requestRender();
    void this.options.cancel(subagentId).then(() => {
      this.cancelling = false;
      this.showList();
      this.options.requestRender();
    }, () => {
      this.cancelling = false;
      this.mode = this.currentDetail() ? "detail" : "list";
      this.options.requestRender();
    });
  }

  private showList(): void {
    this.mode = "list";
    this.detailId = undefined;
    this.confirmList = undefined;
  }

  private currentDetail(): SubagentSnapshot | undefined {
    if (!this.detailId) return undefined;
    return rowsFor(this.options.snapshots()).find((row) => row.snapshot.subagentId === this.detailId)?.snapshot;
  }
}
