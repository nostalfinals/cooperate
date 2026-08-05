import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

export function compactPreview(value: string, maxLength = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "<none>";
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

export function truncateForTool(value: string): string {
  const head = truncateHead(value);
  if (!head.truncated || head.content.length > 0) return head.content;
  // Pi's head truncator deliberately returns no partial first line. Final
  // replies can legitimately be one long line, so retain Pi's bounded tail
  // rather than turning a nonempty result into an empty tool response.
  return truncateTail(value).content;
}
