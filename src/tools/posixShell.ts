/**
 * posixShell.ts — which shell runs a command on macOS/Linux, and what to say when
 * the one we got can't do what the model asked for.
 *
 * THE PROBLEM THIS FIXES. Commands used to run under a hardcoded `/bin/sh`. On
 * Debian and Ubuntu — the most common Linux family by a wide margin — `/bin/sh` is
 * `dash`, a deliberately minimal POSIX shell. Models are overwhelmingly bash-trained,
 * so a perfectly ordinary command like `if [[ -f x ]]; then …` is a SYNTAX ERROR
 * there, and the model gets back a terse dash complaint with no indication that the
 * shell, not the command, is the problem.
 *
 * Windows already had both halves of this handled: it runs PowerShell (a real shell,
 * not the most minimal one available) and `shellLint.ts` tells the model when it has
 * written a bash-ism. POSIX had neither. This module is the missing half.
 *
 * THE FIX, IN TWO LAYERS:
 *   1. Prefer bash. Nearly every macOS and Linux box has it, so the mismatch simply
 *      stops existing. This is the cause, and it is fixed rather than reported.
 *   2. When only a minimal `sh` exists (Alpine, slim containers, busybox), fall back
 *      to it and lint — the residue is rare, but it should still explain itself
 *      instead of failing cryptically.
 *
 * Deciding once, here, is also what keeps the knowledge in one place: before this,
 * "which shell" was a string literal in the middle of a request builder.
 */
import { accessSync, constants } from "node:fs";
// `posix.join` deliberately, not the platform-default `join`: every path this module
// builds is a POSIX path, so it must use forward slashes even when the code is being
// developed or tested on Windows. The platform-default version silently produced
// backslashed paths that could never match anything, which is a bug that would only
// have shown up on the machine least likely to run it.
import { delimiter, posix } from "node:path";

/** The shell a command will actually run in, and whether it speaks bash. */
export interface PosixShell {
  /** Absolute path to the shell binary. */
  bin: string;
  /** True when it is bash — i.e. when bash-only syntax is safe. */
  isBash: boolean;
}

/**
 * Where bash lives, in preference order, before falling back to a PATH lookup.
 * `/bin/bash` covers mainstream Linux and macOS; `/usr/bin/bash` covers distributions
 * that keep it there; `/opt/homebrew/bin/bash` is where a modern bash lands on Apple
 * Silicon (macOS itself still ships bash 3.2, which is fine for our purposes but not
 * everyone's). A PATH lookup then catches NixOS and anything unusual.
 */
const BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

/** Last resort. POSIX guarantees a shell here, whatever it turns out to be. */
const FALLBACK_SH = "/bin/sh";

/**
 * Choose a shell from a candidate list. Pure — `isExecutable` is injected so this is
 * testable on any platform, including the Windows box this is usually developed on.
 */
export function pickShell(
  candidates: readonly string[],
  pathDirs: readonly string[],
  isExecutable: (p: string) => boolean,
): PosixShell {
  for (const bin of candidates) {
    if (isExecutable(bin)) return { bin, isBash: true };
  }
  for (const dir of pathDirs) {
    const bin = posix.join(dir, "bash");
    if (isExecutable(bin)) return { bin, isBash: true };
  }
  return { bin: FALLBACK_SH, isBash: false };
}

/** Is this path a file we can actually execute? Existence is not enough on POSIX: a
 *  readable-but-not-executable file, or a directory, would pass and then fail to spawn. */
export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: PosixShell | null = null;

/** The shell this machine will use, resolved once. */
export function posixShell(): PosixShell {
  if (cached) return cached;
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  cached = pickShell(BASH_CANDIDATES, pathDirs, isExecutableFile);
  return cached;
}

/** Test seam: forget the resolved shell so the next call re-detects. */
export function resetPosixShellCache(): void {
  cached = null;
}

/**
 * Bash-only constructs that are GUARANTEED syntax errors in a strict POSIX shell.
 *
 * Deliberately conservative, exactly like `shellLint.ts`: every entry here must be
 * something dash genuinely cannot parse, because the cost of a false positive is
 * nagging the model about a command that would have worked. Constructs that merely
 * behave differently are left alone.
 */
const BASHISMS: { pattern: RegExp; what: string; fix: string }[] = [
  { pattern: /\[\[|\]\]/, what: "[[ ]] tests", fix: "use [ ] instead" },
  { pattern: /<\(|>\(/, what: "process substitution <( )", fix: "use a pipe or a temp file" },
  { pattern: /(^|\s)source\s/, what: "`source`", fix: "use `.` (dot)" },
  { pattern: /(^|\s)function\s+\w+\s*(\(\s*\))?\s*\{/, what: "the `function` keyword", fix: "write `name() { … }`" },
  { pattern: /\$\{?RANDOM\b/, what: "$RANDOM", fix: "use $$ or awk" },
  { pattern: /\{\d+\.\.\d+\}/, what: "brace ranges like {1..5}", fix: "use seq or a while loop" },
  { pattern: /&>/, what: "&> redirection", fix: "use > file 2>&1" },
  { pattern: /\w+\+=/, what: "+= append", fix: "use var=\"$var…\"" },
  { pattern: /\$\{\w+\[/, what: "arrays", fix: "use separate variables or a delimited string" },
  { pattern: /(^|\s)echo\s+-e\b/, what: "echo -e", fix: "use printf" },
];

/**
 * Warn when a command needs bash but this machine only has a minimal `sh`.
 *
 * Returns null on the overwhelmingly common path — either bash is present (so
 * anything goes) or the command is portable. The note is only for the rare box where
 * the command genuinely cannot run, and it names the construct and the fix rather
 * than leaving the model to interpret a one-line dash error.
 */
export function shellMismatchNote(command: string, shell: PosixShell = posixShell()): string | null {
  if (shell.isBash) return null;
  // Ignore quoted substrings so a bash-ism mentioned inside a string isn't flagged.
  const bare = command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
  const hits = BASHISMS.filter((b) => b.pattern.test(bare));
  if (hits.length === 0) return null;
  const list = hits.map((h) => `${h.what} (${h.fix})`).join("; ");
  return (
    `[This machine has no bash, so commands run under ${shell.bin}, which is a strict POSIX shell. ` +
    `That command uses ${list}. Rewrite it in portable shell syntax.]`
  );
}
