/**
 * verify.ts — the verification gate's fact detectors (pure).
 *
 * The gate's job is narrow and honest: notice when the model edited files this
 * turn and then tried to finish WITHOUT ever checking its work, and nudge once.
 * It decides nothing about engineering — it only reports two observable facts:
 * "was a file changed?" and "was a check run?". WHAT counts as an adequate check
 * for a given task stays the model's judgment (the thin-prompt boundary). Keeping
 * these as pure predicates means the behavior is unit-tested, never blind-shipped.
 */

/** True if a tool call changed files on disk (an edit or a write). */
export function isFileMutation(toolName: string): boolean {
  return (
    toolName === "edit_file" ||
    toolName === "write_file" ||
    toolName === "multi_edit" ||
    toolName === "replace_symbol_body"
  );
}

/** File extensions whose content has no runtime surface — prose/docs, not code or
 *  config. A build, test, or type check can't catch anything in them, so editing
 *  ONLY these needs no verification. Deliberately narrow: config formats like .json,
 *  .toml, .yaml stay OUT (a broken tsconfig/Cargo.toml fails the build), so they DO
 *  need a check. */
const NON_RUNTIME_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
]);

/**
 * Should a mutating tool call oblige the verification gate — i.e. did it change a
 * file with a runtime surface (code/config a check could catch a problem in)?
 * A docs-only edit (MINDWEAVE.md, a README, a .txt) returns false, so the gate never
 * fires on it and the model is never forced to explain that "no check applies".
 * An unknown/extensionless path is treated as code (safe default: the gate fires).
 */
export function mutationNeedsVerification(toolName: string, args: Record<string, unknown>): boolean {
  if (!isFileMutation(toolName)) return false;
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return true; // unknown target — be safe, treat as code
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A dot only counts as an extension if it's in the final path segment.
  const ext = dot > slash ? path.slice(dot).toLowerCase() : "";
  return !NON_RUNTIME_EXTENSIONS.has(ext);
}

/**
 * Does a shell command look like a build / test / typecheck / lint — i.e. a real
 * verification of code? Conservative and matched on the command's program names,
 * so ordinary commands (ls, git status, echo) never read as a check. Case-insensitive.
 */
export function looksLikeVerification(command: string): boolean {
  const c = command.toLowerCase();
  // Package-runner scripts: `npm test`, `npm run build`, `pnpm typecheck`, `yarn lint`, etc.
  if (/\b(npm|pnpm|yarn|bun)\b[^\n|&;]*\b(test|build|lint|typecheck|type-check|check|tsc|vitest|jest)\b/.test(c)) return true;
  // Direct tool invocations across common ecosystems.
  const tools = [
    "tsc",
    "vitest",
    "jest",
    "mocha",
    "eslint",
    "biome",
    "pytest",
    "mypy",
    "ruff",
    "pyright",
    "go test",
    "go build",
    "go vet",
    "cargo test",
    "cargo build",
    "cargo check",
    "cargo clippy",
    "gradle test",
    "mvn test",
    "mvn verify",
    "make test",
    "make check",
    "ctest",
    "rspec",
    "phpunit",
  ];
  return tools.some((t) => new RegExp(`(^|[\\s|&;])${t.replace(/ /g, "\\s+")}\\b`).test(c));
}

/**
 * Did this tool call count as verifying the code? Either the diagnostics tool
 * (LSP errors/warnings) or a shell command that runs a build/test/typecheck/lint.
 */
export function isVerification(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "diagnostics") return true;
  if (toolName === "run_command") return looksLikeVerification(String(args.command ?? ""));
  return false;
}

/**
 * Re-scope guard (pure). A turn is one user request; when the model finishes its
 * whole todo list it has done what was asked. If it then opens a NEW list of
 * pending work in the same turn, it's taking on scope the user never asked for —
 * the "did the same task three times" runaway. This decides, from observable
 * facts alone, whether that has happened.
 *
 *  - `completedBefore` — was a full list already completed earlier this turn?
 *  - `stepResults`     — the tool results from the latest step (name + summary).
 *  - `todos`           — the current task list after the step.
 *
 * Returns the updated `completed` flag (carry it into the next step) and whether
 * the turn should pause. It decides nothing about the code — only turn-taking.
 */
export function reScopeCheck(
  completedBefore: boolean,
  stepResults: readonly { name: string; summary?: string }[],
  todos: readonly { status: string }[] | undefined,
): { completed: boolean; pause: boolean } {
  const finishedNow = stepResults.some(
    (r) => r.name === "todo_write" && r.summary === "all tasks completed",
  );
  const completed = completedBefore || finishedNow;
  // A list finishing clears itself, so the pending check only trips on a genuinely
  // NEW list created after the completion — never on the completing step itself.
  const morePending = todos?.some((t) => t.status !== "completed") ?? false;
  return { completed, pause: completed && morePending };
}

/**
 * Background-poll guard (pure). A background shell's completion is pushed to the
 * model automatically (see backgroundEventNotes), so re-reading a still-running
 * shell with shell_output/list_shells accomplishes nothing — it just spends a step
 * and narrates "still running" to the user, the exact spam a wait-loop produces.
 * This detects a step whose ONLY work was polling background shells that are still
 * running. A step that does any real work alongside (an edit, a file read, a real
 * command) is NOT a poll step, so genuine progress never trips the guard.
 */
export function isBackgroundPollStep(
  stepResults: readonly { name: string; summary?: string }[],
): boolean {
  if (stepResults.length === 0) return false;
  const isStatusRead = (name: string) => name === "shell_output" || name === "list_shells";
  if (!stepResults.every((r) => isStatusRead(r.name))) return false;
  // At least one polled shell must still be RUNNING — a poll that finds the shell
  // already finished is legitimate (the model reads the result and reports it).
  // shell_output summary reads "shell #1 (running)"; list_shells reads "N running,
  // M total" (N≥1 only when something is actually running — avoids "0 running").
  return stepResults.some((r) => /\(running\)|[1-9]\d* running/i.test(r.summary ?? ""));
}

/**
 * Repeat-failure breaker (pure). A weaker model can get stuck firing the SAME thing
 * over and over when it keeps failing — an edit that errors "file not found" six times,
 * or ten near-identical PowerShell commands that all die with the same error — because
 * it doesn't recognize the error is the same and never changes course. The fix is to key
 * the repeat detection on the ERROR MESSAGE, not the exact command — which is what catches
 * a run of slightly-different commands that all fail identically.
 *
 * `stepFailureSignature` returns a stable signature for a step whose EVERY tool result
 * errored (a pure-failure step), or null otherwise — any success alongside is progress,
 * so the streak resets. The engine counts consecutive identical signatures and stops
 * losslessly once they cross a small limit, surfacing the real error to the user.
 */
export function stepFailureSignature(
  results: readonly { name: string; output: string; isError: boolean }[],
): string | null {
  if (results.length === 0) return null;
  // Any non-error result means the step made some progress — not a pure-failure step.
  if (!results.every((r) => r.isError)) return null;
  return results
    .map((r) => `${r.name}:${normalizeErrorSignature(r.output)}`)
    .sort()
    .join("|");
}

/**
 * Collapse an error output to its stable core so two failures of the same KIND match
 * even when the offending command differs. Drops the noise that varies call-to-call:
 * PowerShell's code-echo/caret lines (start with `+` or `~`) and its `At line:N char:N`
 * locators, then strips digits (so `char:80` and `char:99` unify) and collapses space.
 * Harmless on non-PowerShell output — plain error text passes through digit-normalized.
 */
export function normalizeErrorSignature(output: string): string {
  const kept = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((t) => {
      if (t === "") return false;
      if (t.startsWith("+") || /^~+$/.test(t)) return false; // PS code-echo / caret underline
      if (/at line:\d+ char:\d+/i.test(t)) return false; // PS location line
      return true;
    });
  return kept
    .join(" ")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** The one-shot nudge injected when files changed but nothing was checked. */
export const VERIFY_NUDGE =
  "You edited files this turn but never ran a check. Before finishing, verify what you changed actually " +
  "works — run the project's build or tests, or call `diagnostics` on the files you touched, and fix anything " +
  "it surfaces. If no check meaningfully applies here (for example a docs or config edit), say so in one line " +
  "and finish. (This reminder fires once per turn.)";
