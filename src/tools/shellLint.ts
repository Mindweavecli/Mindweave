/**
 * shellLint.ts — a conservative advisory for bash-isms in a Windows PowerShell
 * command (pure, so it's unit-tested).
 *
 * Models are overwhelmingly bash-trained, but Mindweave runs commands in
 * powershell.exe (5.1) on Windows, where some bash constructs silently break:
 * `&&`/`||` are parse errors, `2>/dev/null` isn't a thing, and tools like `grep`
 * / `sed` / `head` don't exist. This returns a short note the caller appends to
 * the command result so the model corrects itself next time.
 *
 * Deliberately conservative — it must NOT flag valid PowerShell. In particular
 * `ls`, `cat`, `rm`, `cp`, `mv`, `echo`, `pwd`, `sort` are real PowerShell
 * ALIASES and work fine, so they are never flagged. Only genuinely-broken
 * constructs are. Quoted substrings are ignored to avoid matching inside strings.
 */

/** GNU/bash tools with no PowerShell alias (so they fail on a stock Windows box). */
const BASH_ONLY_TOOLS = ["grep", "sed", "awk", "head", "tail", "touch", "which", "wc"];

/**
 * The subset of bash-isms that are GUARANTEED Windows PowerShell 5.1 PARSE ERRORS —
 * the command cannot run at all. Used as a PRE-execution gate so a run isn't wasted on
 * a command that will only ever fail to parse. ONLY `&&`/`||` qualify: everything else
 * the advisory notes (missing tools, `/dev/null`, `export`) actually executes — and a
 * tool like `grep` may even be on PATH — so those must stay advisory, never blocked.
 * Returns a fix hint (including the `shell:'cmd'` escape hatch) or null.
 */
export function powershellParseError(command: string): string | null {
  const bare = command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
  if (/\&\&|\|\|/.test(bare)) {
    return (
      "`&&`/`||` are parse errors in Windows PowerShell — this command won't run. Join with `;` " +
      "(use `if`/`$?` to stop on failure), or pass shell:'cmd' to run it in cmd.exe, which supports `&&`/`||`."
    );
  }
  return null;
}

/**
 * PowerShell automatic variables that are read-only/constant — assigning to one throws
 * "Cannot overwrite variable X because it is read-only or constant" and the command dies.
 * `$pid` is the one models reach for constantly (parsing a PID out of netstat), which is
 * exactly the wall that turned a "start the app" request into a 90-second flailing loop.
 * This is the constant set from PowerShell's own `AvoidAssignmentToAutomaticVariable`
 * rule that hard-errors on assignment ($null is excluded — assigning it is a silent no-op).
 */
const PS_READONLY_VARS = ["PID", "Host", "ExecutionContext", "PSHOME", "ShellId", "true", "false"];

/**
 * A guaranteed runtime failure: assigning to a read-only automatic variable. Detected
 * pre-execution (like the `&&` parse gate) so the run isn't wasted — the model gets the
 * fix immediately instead of firing the command, reading the error, and retrying. Only
 * ASSIGNMENT is flagged (`$pid = …`), never a read/compare (`if ($pid -eq …)`). Quoted
 * spans are blanked first so a literal inside a string never trips it. Returns the fix
 * hint or null.
 */
export function powershellReservedAssignmentReason(command: string): string | null {
  const bare = command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
  const re = new RegExp(`\\$(${PS_READONLY_VARS.join("|")})\\s*\\+?=(?!=)`, "i");
  const m = bare.match(re);
  if (!m) return null;
  const name = m[1]!;
  return (
    `\`$${name}\` is a read-only automatic variable in Windows PowerShell — assigning to it fails with ` +
    `"Cannot overwrite variable ${name} because it is read-only or constant." Use a different variable ` +
    `name (e.g. \`$procId\` instead of \`$pid\`).`
  );
}

/**
 * A one-line advisory if `command` contains a clear bash-ism that breaks in
 * Windows PowerShell, else null. `command` is the raw command the model sent.
 */
export function powershellLintReason(command: string): string | null {
  // Blank out quoted spans so we don't match inside string literals.
  const bare = command
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ");

  const problems: string[] = [];

  if (/\&\&|\|\|/.test(bare)) {
    problems.push("`&&`/`||` are parse errors in Windows PowerShell 5.1 — run separate commands or join with `;` (use `if`/`$?` to stop on failure)");
  }
  if (/\/dev\/null/.test(bare)) {
    problems.push("`/dev/null` doesn't exist — redirect with `2>$null` / `>$null`");
  }
  // A bash-only tool in command position: at the start, or right after ; | & (
  const toolRe = new RegExp(`(^|[;|&(])\\s*(${BASH_ONLY_TOOLS.join("|")})\\b`, "i");
  const m = bare.match(toolRe);
  if (m) {
    const tool = m[2]!.toLowerCase();
    const suggestion: Record<string, string> = {
      grep: "Select-String",
      sed: "-replace / Get-Content",
      awk: "Select-Object / ForEach-Object",
      head: "Get-Content -TotalCount N",
      tail: "Get-Content -Tail N",
      touch: "New-Item",
      which: "(Get-Command x).Source",
      wc: "Measure-Object",
    };
    problems.push(`\`${tool}\` isn't available in PowerShell — use \`${suggestion[tool]}\` (or Mindweave's grep/read tools)`);
  }
  if (/(^|[;|&(])\s*export\s+\w+=/.test(bare)) {
    problems.push("bash `export VAR=...` doesn't work — use `$env:VAR = '...'`");
  }

  if (problems.length === 0) return null;
  return `Note: this looks like bash, but the shell is Windows PowerShell. ${problems.join("; ")}.`;
}
