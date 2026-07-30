/**
 * ToolLine — a tool's activity row.
 *
 *   ● Update(home.html)
 *     ⎿ - <a href="#" class="btn">
 *       + <a href="catalog.html" class="btn">
 *
 * The dot reflects lifecycle: dim while running, white when ok, red on error. The
 * bold `Name(arg)` sits on the first row; once resolved, an indented `⎿` branch
 * hangs beneath with the rich detail (an edit diff, a file preview, command
 * output) or a one-line summary. The whole result appears AT ONCE on resolve —
 * never a live, line-by-line scroll (that churn is what made the old version
 * glitch).
 */
import { Box, Text } from "ink";
import { KIND_COLOR, ERROR_COLOR, type ToolKind } from "../toolDisplay.js";

const DOT = "●";
const BRANCH = "⎿";
// The branch nests one level UNDER the tool label: the `⎿` sits beneath the name's
// first letter (col 2) and continuation rows align under the branch content, so the
// result reads as belonging to the tool call instead of hanging in the dot gutter.
const BRANCH_INDENT = 4;

export interface ToolLineProps {
  name: string;
  arg?: string;
  status: "running" | "ok" | "error";
  /** Action category — colours the dot (blue family; red when it errors). */
  action?: ToolKind;
  summary?: string;
  detail?: string;
  columns: number;
  /** Consecutive tool rows hug; one after prose keeps a blank line above. */
  tightTop?: boolean;
}

export function ToolLine({ name, arg, status, action, summary, detail, columns, tightTop }: ToolLineProps) {
  const errored = status === "error";
  // The dot carries the action at a glance: its category colour when it succeeds,
  // dim while still running, red when it failed.
  const dotColor = errored ? ERROR_COLOR : action ? KIND_COLOR[action] : undefined;
  // Trim a long arg from the FRONT so the meaningful tail (a filename) stays
  // visible and the header never wraps to column 0.
  const headerRoom = Math.max(12, columns - name.length - 6);
  const shownArg = arg && arg.length > headerRoom ? "…" + arg.slice(-(headerRoom - 1)) : arg;

  // The branch content: rich detail lines if present, else the one-line summary.
  const branchLines = detail ? detail.split("\n") : summary ? [summary] : [];

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={dotColor} dimColor={status === "running"}>{DOT}</Text>
        </Box>
        <Text bold>{name}</Text>
        {shownArg ? <Text>({shownArg})</Text> : null}
      </Box>
      {status !== "running" && branchLines.length > 0 ? (
        <BranchLines lines={branchLines} columns={columns} errored={errored} diff={!!detail} />
      ) : null}
    </Box>
  );
}

/** The indented `⎿` result block, one source line per row, diff-colored when the
 *  content is a diff/preview (`+ ` green, `- ` red; everything else dim). */
function BranchLines({
  lines,
  columns,
  errored,
  diff,
}: {
  lines: string[];
  columns: number;
  errored: boolean;
  diff: boolean;
}) {
  const content = Math.max(8, columns - BRANCH_INDENT - 1);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const color = errored ? "red" : diff ? diffColor(line) : undefined;
        const dim = !errored && color === undefined;
        return (
          <Box key={i} flexDirection="row" width={columns}>
            <Text dimColor>{i === 0 ? `  ${BRANCH} ` : "    "}</Text>
            <Box width={content}>
              <Text color={color} dimColor={dim} wrap="truncate-end">{line}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Diff line color by prefix; undefined means "not a diff line" (caller dims it). */
function diffColor(line: string): string | undefined {
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined;
}
