/**
 * SubagentView — a spawned sub-agent as a distinct NESTED block.
 *
 *   ◆ Subagent · read-only   find every authFetch call site
 *   │ Searching authFetch
 *   │ Read login.ts
 *   │ Read api.ts
 *     ⎿ 3 steps · read-only        ← collapses here once it reports back
 *
 * A violet ◆ marker and rail set it apart from the blue tool family — it reads as a
 * separate mind working inside the transcript, not just another tool. Its own tool
 * calls stream in live as compact rail items (the "live compact activity" the child
 * does), then it seals to a one-line summary. The child's prose/reasoning is never
 * shown; only its final distilled report crosses back, as the spawn tool's result.
 */
import { Box, Text } from "ink";
import { KIND_COLOR, ERROR_COLOR } from "../toolDisplay.js";
import { collapseAdjacent } from "../toolItems.js";
import type { ToolGroupItem, ToolStatus } from "../transcript.js";

const DIAMOND = "◆";
const BRANCH = "⎿";
const RAIL = "│";
// The rail/branch occupy 3 columns; item text hangs beside them, aligned under the
// header content and never spilling left into the marker gutter.
const RAIL_INDENT = 3;
const AGENT_COLOR = KIND_COLOR.agent;

export function SubagentView({
  task,
  readOnly,
  status,
  summary,
  items,
  done,
  columns,
  tightTop,
}: {
  task: string;
  readOnly: boolean;
  status: ToolStatus;
  summary?: string;
  items: ToolGroupItem[];
  done: boolean;
  columns: number;
  tightTop?: boolean;
}) {
  const errored = status === "error";
  // The marker carries the sub-agent identity: violet while it works and when it
  // succeeds, red if it failed. Dim (breathing-less, just recessed) until it's done.
  const dotColor = errored ? ERROR_COLOR : AGENT_COLOR;
  const content = Math.max(8, columns - RAIL_INDENT - 1);
  const taskLabel = clip(task, Math.max(16, columns - 22));

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={dotColor} dimColor={!done}>{DIAMOND}</Text>
        </Box>
        <Text bold color={dotColor}>Subagent</Text>
        {readOnly ? <Text dimColor> · read-only</Text> : null}
        {taskLabel ? <Text dimColor>{"  "}{taskLabel}</Text> : null}
      </Box>

      <Box flexDirection="column">
        {collapseAdjacent(items).map((row) => (
          <Box key={row.item.toolId} flexDirection="row" width={columns}>
            <Text color={AGENT_COLOR} dimColor>{` ${RAIL} `}</Text>
            <Box width={content}>
              <Text
                color={row.anyError ? "red" : undefined}
                dimColor={!row.anyError}
                wrap="truncate-end"
              >
                {row.label}{row.count > 1 ? `  ×${row.count}` : ""}
              </Text>
            </Box>
          </Box>
        ))}
        {done && summary ? (
          <Box flexDirection="row" width={columns}>
            <Text dimColor>{` ${BRANCH} `}</Text>
            <Box width={content}>
              <Text color={errored ? "red" : undefined} dimColor={!errored} wrap="truncate-end">
                {summary}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** Flatten and clip a task to one short line for the header. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (max <= 1) return "";
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
