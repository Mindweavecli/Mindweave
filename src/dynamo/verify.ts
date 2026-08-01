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

/**
 * What the breaker should do at a given streak length. Two tiers, deliberately:
 *
 * Stopping the turn the moment a streak trips is the wrong reflex. The model has
 * no idea it repeated itself — nothing in the conversation says so — so a hard stop
 * punishes it for a fact it was never told. Worse, it removes the one thing that
 * would actually fix the situation: a chance to look at why.
 *
 * So the first trip INTERRUPTS: the loop injects the fact (same thing, N times, same
 * error, here's where your shell actually is) and continues. Only if the model repeats
 * it AGAIN after being told does the turn stop. That second tier is what keeps this a
 * real backstop rather than an endless nudge, and it costs one model round-trip.
 */
export type RepeatFailureStep = "none" | "nudge" | "stop";

export function repeatFailureStep(streak: number, limit: number, nudged: boolean): RepeatFailureStep {
  if (streak < limit) return "none";
  return nudged ? "stop" : "nudge";
}

/**
 * The first line of an error worth showing a human: skips blanks and PowerShell's
 * code-echo/caret decoration, and clips so one runaway line can't fill the screen.
 */
export function firstErrorLine(output: string, max = 200): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("+") && !/^~+$/.test(l)) ?? "the same error";
  return line.length > max ? line.slice(0, max - 3) + "…" : line;
}

/**
 * A one-line label for the thing that kept failing. For a shell command that's the
 * command itself (the actual repeated text); for anything else it's the tool plus
 * whichever argument identifies what it acted on.
 */
export function failedActionLabel(name: string, args: Record<string, unknown>): string {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command) return command.length > 160 ? command.slice(0, 157) + "…" : command;
  const target = ["path", "file_path", "file", "pattern", "query"]
    .map((k) => args[k])
    .find((v) => typeof v === "string" && v) as string | undefined;
  return target ? `${name} ${target}` : name;
}

/**
 * The interrupt injected on the first trip of the breaker.
 *
 * Every sentence here is a FACT the model cannot otherwise see: how many times it
 * repeated itself, what it repeated, what the error was, where its shell actually is,
 * and what the harness will do next. That last one matters — the model can only weigh
 * "retry once more" against a stop if it knows the stop is coming.
 *
 * `cwd` is included only when the shell has moved off the project root, which is the
 * failure this was written for: `cd` persists within a turn, so a later relative path
 * silently resolves from somewhere else and the model has no way to notice.
 */
export function repeatFailureNudge(opts: {
  attempts: number;
  action: string;
  error: string;
  cwd?: string;
}): string {
  const where = opts.cwd
    ? `Your shell is currently in ${opts.cwd}, not the project root. Relative paths resolve from there, ` +
      `so a path that looks right from the root will not be.\n\n`
    : "";
  return (
    `You have now run this ${opts.attempts} times and gotten the same error every time:\n\n` +
    `    ${opts.action}\n` +
    `    ${opts.error}\n\n` +
    where +
    `Running it again unchanged will end the turn. Find out why it fails before you act again: ` +
    `check the path or file it names, confirm the state you are actually in, or take a different ` +
    `route to the same goal. (This fires once per failure loop.)`
  );
}

/** The one-shot nudge injected when files changed but nothing was checked. */
export const VERIFY_NUDGE =
  "You edited files this turn but never ran a check. Before finishing, verify what you changed actually " +
  "works — run the project's build or tests, or call `diagnostics` on the files you touched, and fix anything " +
  "it surfaces. If no check meaningfully applies here (for example a docs or config edit), say so in one line " +
  "and finish. (This reminder fires once per turn.)";
