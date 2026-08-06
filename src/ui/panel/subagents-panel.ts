import { Container, type Component } from "@earendil-works/pi-tui";
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
  private selectedId?: string;
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
      detailSnapshot: () => (this.detailId ? options.snapshotOf(this.detailId) : undefined),
      getTree: (subagentId) => options.getTree(subagentId),
      getSteeringMessages: (subagentId) => options.getSteeringMessages(subagentId),
      cancel: (subagentId) => options.cancel(subagentId),
      replaceSteering: (subagentId, text) => options.replaceSteering(subagentId, text),
      requestRender: () => options.requestRender(),
      close: () => {
        this.dispose();
        options.close();
      },
      selectedId: () => this.selectedId,
      selectId: (id) => {
        this.selectedId = id;
      },
      selectedEntryId: () => this.selectedEntryId,
      selectEntry: (id) => {
        this.selectedEntryId = id;
      },
      showList: () => this.showList(),
      showDetail: (id) => {
        this.detailId = id;
        this.selectedEntryId = undefined;
        this.active = new DetailView(this.ctx);
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
    this.active = new ListView(this.ctx);
    if (options.startTimer) this.timer = setInterval(options.requestRender, 1_000);
  }

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
    this.detailId = undefined;
    this.selectedEntryId = undefined;
    this.active = new ListView(this.ctx);
  }
}
