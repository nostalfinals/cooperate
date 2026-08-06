import { Container, Text } from "@earendil-works/pi-tui";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";

export function shell(theme: Theme, title: string | undefined, bodyLines: string[], footer: string): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  const parts: string[] = [];
  if (title !== undefined) parts.push("", theme.fg("accent", theme.bold(title)));
  parts.push("", ...bodyLines, "", theme.fg("dim", footer), "");
  container.addChild(new Text(parts.join("\n"), 1, 0));
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  return container;
}

export function selectable(line: string, selected: boolean, theme: Theme, cursor = "›", prefix = 2): string {
  if (!selected) return " ".repeat(prefix) + line;
  return theme.bg("selectedBg", theme.fg("accent", cursor + " "))
    + theme.bg("selectedBg", theme.bold(line));
}

export function confirmOption(line: string, selected: boolean, theme: Theme): string {
  if (!selected) return "  " + line;
  return theme.fg("accent", "→ ") + theme.fg("accent", line);
}
