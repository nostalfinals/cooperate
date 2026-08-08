import type { Component } from "@earendil-works/pi-tui";
import type { PanelContext, PanelOptions, PanelView } from "./types.ts";
import { ListView } from "./list.ts";
import { DetailView } from "./detail.ts";
import { MessageView } from "./message.ts";
import { ConfirmView } from "./confirm.ts";
import { SteerView } from "./steer.ts";

export class SubagentsPanel implements Component {
  private readonly options: PanelOptions;
  private readonly ctx: PanelContext;
  private active: PanelView;
  private tab: "active" | "history" = "active";
  private activeSelectedId?: string;
  private historySelectedId?: string;
  private detailId?: string;
  private selectedEntryId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: PanelOptions) {
    this.options = options;
    const maxVisible = Math.max(5, Math.floor(options.terminalRows / 2));
    this.ctx = {
      theme: options.theme,
      maxVisible,
      snapshots: () => options.snapshots(),
      detailSnapshot: () => (this.detailId
        ? (this.tab === "history" ? options.historyDetail(this.detailId)?.snapshot : options.snapshotOf(this.detailId))
        : undefined),
      getTree: (subagentId) => this.tab === "history" ? options.getHistoryTree(subagentId) : options.getTree(subagentId),
      getSteeringMessages: (subagentId) => options.getSteeringMessages(subagentId),
      cancel: (subagentId) => options.cancel(subagentId),
      replaceSteering: (subagentId, text) => options.replaceSteering(subagentId, text),
      requestRender: () => options.requestRender(),
      close: () => {
        this.releaseHistoryDetail();
        this.dispose();
        options.close();
      },
      selectedId: () => this.tab === "history" ? this.historySelectedId : this.activeSelectedId,
      selectId: (id) => {
        if (this.tab === "history") this.historySelectedId = id;
        else this.activeSelectedId = id;
      },
      selectedEntryId: () => this.selectedEntryId,
      selectEntry: (id) => {
        this.selectedEntryId = id;
      },
      tab: () => this.tab,
      switchTab: () => {
        if (this.active !== this.listView) return;
        this.releaseHistoryDetail();
        this.tab = this.tab === "active" ? "history" : "active";
        this.detailId = undefined;
        this.selectedEntryId = undefined;
      },
      historyRoots: () => options.historyRoots(),
      historyDetail: (subagentId) => options.historyDetail(subagentId),
      getHistoryTree: (subagentId) => options.getHistoryTree(subagentId),
      showList: () => this.showList(),
      showDetail: (id) => {
        this.detailId = id;
        this.selectedEntryId = undefined;
        this.active = new DetailView(this.ctx);
        if (this.tab === "history") {
          void options.loadHistoryTree(id).then(() => options.requestRender());
        }
      },
      backToDetail: () => {
        this.active = new DetailView(this.ctx);
      },
      showMessage: () => {
        this.active = new MessageView(this.ctx);
      },
      showConfirm: () => {
        this.active = new ConfirmView(this.ctx);
      },
      showSteer: () => {
        this.active = new SteerView(this.ctx);
      },
      isCurrent: (view) => this.active === view,
    };
    this.listView = new ListView(this.ctx);
    this.active = this.listView;
    if (options.startTimer) this.timer = setInterval(options.requestRender, 1_000);
  }

  private listView!: ListView;

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active.dispose?.();
    this.options.onDispose?.();
  }

  handleInput(data: string): void {
    this.active.handleInput(data);
    this.options.requestRender();
  }

  render(width: number): string[] {
    if (this.active.stale?.()) this.showList();
    return this.active.render(width).render(width);
  }

  private showList(): void {
    this.releaseHistoryDetail();
    this.detailId = undefined;
    this.selectedEntryId = undefined;
    this.active = this.listView;
  }

  private releaseHistoryDetail(): void {
    if (this.detailId) this.options.releaseHistoryTree(this.detailId);
  }
}
