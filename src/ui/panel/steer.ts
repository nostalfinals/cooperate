import { Container, Input } from "@earendil-works/pi-tui";
import { isActive } from "../../subagent/types.ts";
import { shell } from "./shell.ts";
import { key, type PanelContext, type PanelView } from "./types.ts";

export class SteerView implements PanelView {
  private readonly ctx: PanelContext;
  private readonly input: Input;

  constructor(ctx: PanelContext) {
    this.ctx = ctx;
    this.input = new Input();
    const snapshot = ctx.detailSnapshot();
    if (snapshot) {
      const steering = ctx.getSteeringMessages(snapshot.subagentId);
      if (steering.length > 0) this.input.setValue(steering.join("\n"));
    }
    this.input.onSubmit = (text) => this.submit(text);
    this.input.onEscape = () => ctx.backToDetail();
  }

  handleInput(data: string): void {
    if (key(data, "escape")) {
      this.ctx.backToDetail();
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number): Container {
    const theme = this.ctx.theme;
    const snapshot = this.ctx.detailSnapshot();
    const lines: string[] = [theme.fg("muted", "Steering instruction:")];
    lines.push(...this.input.render(width - 2).map((line) => line.replace(/\s+$/u, "")));
    return shell(theme, snapshot ? `Steer ${snapshot.agent}` : "Steer", lines, "enter send · esc back");
  }

  private submit(text: string): void {
    const snapshot = this.ctx.detailSnapshot();
    this.ctx.backToDetail();
    if (!snapshot || !isActive(snapshot) || text.trim().length === 0) return;
    void this.ctx.replaceSteering(snapshot.subagentId, text.trim());
  }
}
