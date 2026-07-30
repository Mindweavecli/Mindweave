/**
 * ToolGroup — a single consolidated row for a burst of discovery calls (reads,
 * searches, lists, code-map queries), instead of one stacked row per call.
 *
 *   ● Exploring 9 items…         ← while the burst runs, the count climbs
 *   ● Explored 11 items          ← once done, it settles to the total
 *
 * Just the header line — no per-item list beneath it. The count already tells the
 * story; the individual reads/searches are detail few people read, and hiding them
 * keeps a busy turn calm. Mutating tools (edits, writes, runs) are NOT grouped —
 * they keep their own row with the diff/output, since that detail is worth seeing.
 * See isGroupable.
 */
import { Box, Text } from "ink";
import { KIND_COLOR, ERROR_COLOR } from "../toolDisplay.js";
import type { ToolGroupItem } from "../transcript.js";

const DOT = "●";

export function ToolGroup({
  items,
  done,
  tightTop,
}: {
  items: ToolGroupItem[];
  done: boolean;
  columns: number;
  tightTop?: boolean;
}) {
  const n = items.length;
  const anyError = items.some((it) => it.status === "error");
  const header = done
    ? `Explored ${n} ${n === 1 ? "item" : "items"}`
    : `Exploring ${n} ${n === 1 ? "item" : "items"}…`;

  // The discovery dot takes the group's dominant action colour (reads vs searches),
  // dim while the burst runs, red if any call in it failed.
  const dotColor = anyError && done ? ERROR_COLOR : KIND_COLOR[dominantKind(items)];

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="row">
      <Box minWidth={2}>
        <Text color={dotColor} dimColor={!done}>{DOT}</Text>
      </Box>
      <Text bold>{header}</Text>
    </Box>
  );
}

/** The most common action in a discovery burst — used to colour its dot. Defaults
 *  to "search" (the family reads/greps/maps all belong to). */
function dominantKind(items: ToolGroupItem[]): "read" | "search" {
  const reads = items.filter((it) => it.kind === "read").length;
  return reads > items.length / 2 ? "read" : "search";
}
