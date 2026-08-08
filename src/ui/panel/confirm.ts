import { Container } from "@earendil-works/pi-tui";
import { isActive } from "../../subagent/types.ts";
import { shell, confirmOption } from "./shell.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

/** Cancellation confirmation for the subagent shown in detail. */
export class ConfirmView implements PanelView {
  private readonly ctx: PanelContext;
  private confirmChoice: "no" | "yes" = "no";
  private cancelling = false;

  constructor(ctx: PanelContext) {
    this.ctx = ctx;
  }

  handleInput(data: string): void {
    if (this.cancelling) return;
    if (key(data, "escape")) {
      this.ctx.backToDetail();
      return;
    }
    if (key(data, "up") || key(data, "down")) {
      this.confirmChoice = this.confirmChoice === "no" ? "yes" : "no";
      return;
    }
    if (key(data, "enter")) {
      this.chooseConfirm(this.confirmChoice);
    }
  }

  render(_width: number): Container {
    const theme = this.ctx.theme;
    const snapshot = this.ctx.detailSnapshot();
    const lines: string[] = [];
    if (this.cancelling) {
      lines.push(theme.fg("muted", "cancelling…"));
    } else if (snapshot) {
      lines.push(`Do you really want to cancel subagent ${snapshot.agent}?`, "");
      lines.push(confirmOption("No", this.confirmChoice === "no", theme));
      lines.push(confirmOption("Yes", this.confirmChoice === "yes", theme));
    }
    return shell(theme, "Confirm Cancellation", lines, "enter select");
  }

  private chooseConfirm(choice: "no" | "yes"): void {
    const snapshot = this.ctx.detailSnapshot();
    if (!snapshot || !isActive(snapshot)) {
      // Subagent finished while the confirmation was open: both choices no-op.
      this.ctx.backToDetail();
      return;
    }
    if (choice === "no") {
      this.ctx.backToDetail();
      return;
    }
    this.cancelling = true;
    this.ctx.requestRender();
    void this.ctx.cancel(snapshot.subagentId).then(() => {
      this.cancelling = false;
      this.ctx.showList();
    }, () => {
      this.cancelling = false;
      this.ctx.backToDetail();
    });
  }
}
