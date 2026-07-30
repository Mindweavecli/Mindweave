/**
 * toolDisplay.ts — map a Mindweave tool call to its display name + argument.
 *
 * A compact tool header: a bold verb-noun name and the one telling
 * argument in parens — `Update(home.html)`, `Search(refreshToken)`, `Run(npm
 * test)`. Pure, display-only (never sent to a model), and deterministic from the
 * tool name + parsed args.
 */

/** Raw tool name → the bold display name shown in the row. */
const DISPLAY_NAME: Record<string, string> = {
  read_file: "Read",
  read_symbol: "Read",
  edit_file: "Update",
  write_file: "Write",
  grep: "Search",
  glob: "Glob",
  list_dir: "List",
  run_command: "Run",
  outline: "Map",
  definition: "Map",
  references: "Map",
  relevant: "Map",
  diagnostics: "Check",
  web_fetch: "Fetch",
  use_skill: "Skill",
  create_skill: "Skill",
  todo_write: "Todo",
  add_directory: "Add",
  link_workspace: "Link",
  remember_rule: "Rule",
  forbid_path: "Forbid",
  spawn_subagent: "Subagent",
  shell_output: "Shell",
  list_shells: "Shell",
};

// The read-only "exploring the codebase" tools. Consecutive calls to these are
// consolidated into one updating group row instead of a separate line each, so a
// burst of reads/searches reads as "Exploring… (9)" not nine stacked rows.
// Mutating tools (edit/write/run) and one-offs (skills, fetch) stay individual.
const GROUPABLE = new Set([
  "read_file",
  "read_symbol",
  "glob",
  "grep",
  "list_dir",
  "outline",
  "definition",
  "references",
  "relevant",
  // Background-shell status checks: silent, and a model tends to POLL them in a loop
  // while waiting on a build — so they fold into the group and their repeats collapse
  // (see collapseAdjacent) instead of stacking a row per poll. kill_shell mutates → stays.
  "shell_output",
  "list_shells",
  // Diagnostics: read-only, and a model runs them in a burst right after editing —
  // a Check per file stacks a wall of "no diagnostics" rows. Its one-line summary
  // ("no diagnostics" / "2 errors, 1 warning") carries into the group note (red on
  // failure), and the model still gets the full error listing via the tool output.
  "diagnostics",
]);

/** Whether a tool call should fold into the discovery group rather than its own row. */
export function isGroupable(name: string): boolean {
  return GROUPABLE.has(name);
}

/**
 * The action a tool performs, used to colour its row dot. A small blue family
 * (with red reserved for failures) so the transcript reads at a glance — the
 * product's blue/black vision: looking is light, changing is vivid, running is
 * indigo, a failure is red.
 */
export type ToolKind = "read" | "search" | "edit" | "write" | "run" | "check" | "agent" | "meta";

const TOOL_KIND: Record<string, ToolKind> = {
  read_file: "read",
  read_symbol: "read",
  grep: "search",
  glob: "search",
  list_dir: "search",
  outline: "search",
  definition: "search",
  references: "search",
  relevant: "search",
  web_fetch: "search",
  edit_file: "edit",
  multi_edit: "edit",
  replace_symbol_body: "edit",
  write_file: "write",
  run_command: "run",
  diagnostics: "check",
  spawn_subagent: "agent",
  shell_output: "run",
  list_shells: "run",
  // everything else (todo, skills, rules, workspace) → "meta"
};

/** The action category for a raw tool name (defaults to bookkeeping "meta"). */
export function toolKind(name: string): ToolKind {
  return TOOL_KIND[name] ?? "meta";
}

/** Terminal colour per action kind — a blue family, truecolor hex (terminals that
 *  can't render it downsample gracefully). Red is reserved for the error state. */
export const KIND_COLOR: Record<ToolKind, string> = {
  read: "#7cc4ff", // light blue — looking at code
  search: "#4a90d9", // blue — searching / mapping the codebase
  edit: "#3b82f6", // vivid blue — changing code
  write: "#38bdf8", // sky — creating a file
  run: "#6366f1", // indigo — running a command
  check: "#22d3ee", // cyan — diagnostics / verifying
  agent: "#a78bfa", // violet — a spawned sub-agent (set apart from the blue tool family)
  meta: "#60a5fa", // soft blue — bookkeeping (todo, skills, rules)
};

/** The dot colour for a failed tool / failed test. */
export const ERROR_COLOR = "#ff5f56";

export interface ToolDisplay {
  name: string;
  arg?: string;
  /** Action category, for the row's dot colour. */
  kind: ToolKind;
}

/** Build the `Name(arg)` display parts for a tool call. */
export function toolDisplay(name: string, args: Record<string, unknown>): ToolDisplay {
  const display = DISPLAY_NAME[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  const kind = toolKind(name);

  if (name === "grep" || name === "glob") return { name: display, arg: str(args.pattern) || undefined, kind };
  if (name === "run_command") return { name: display, arg: clip(str(args.command), 48) || undefined, kind };
  if (name === "web_fetch") return { name: display, arg: clip(str(args.url), 48) || undefined, kind };
  if (name === "spawn_subagent") return { name: display, arg: clip(str(args.task), 48) || undefined, kind };

  const path = str(args.path);
  const detail = path ? base(path) : str(args.symbol) || str(args.name) || str(args.query) || str(args.label);
  return { name: display, arg: detail || undefined, kind };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A path's last segment, so rows stay short: `src/a/session.ts` → `session.ts`. */
function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
