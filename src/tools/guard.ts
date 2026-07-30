/**
 * guard.ts — the mechanical safety floor for the mutating tools.
 *
 * Two deterministic checks, no model judgment and no prompt rules (keeping the
 * "how to behave safely" decision out of the prompt is deliberate — the wall is
 * physical, the model is simply told why and adapts):
 *
 *  1. `protectedPathReason` — some files must never be read or written by the
 *     agent regardless of what it's asked: secrets (`.env`), keys (`.ssh`,
 *     `*.pem`, `id_rsa`), and the git internals (`.git/`) whose corruption would
 *     wreck the repo. This mirrors the deny-lists every serious coding agent
 *     ships; user-configurable rules can layer on later.
 *
 *  2. `catastrophicCommandReason` — a tiny, high-confidence blocklist of shell
 *     commands that are essentially never a legitimate coding action and are
 *     irreversible (wipe the disk, fork-bomb, reformat). This is NOT a sandbox
 *     or an injection parser — a single-user local tool doesn't need a heavyweight
 *     shell analyzer. It's a seatbelt against the few commands that turn a model
 *     mistake into a destroyed machine.
 *
 * Both return a human reason string when they fire, or `null` to allow. Fail
 * open by design: anything not explicitly matched is allowed.
 */

// Path segments / names that are off-limits. Matched against the POSIX-style
// path so it works the same on Windows and Unix.
const PROTECTED_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /(^|\/)\.env(\.|$|\/)/i, what: "an environment/secrets file" },
  { test: /(^|\/)\.git(\/|$)/i, what: "the git internals directory" },
  { test: /(^|\/)\.ssh(\/|$)/i, what: "an SSH key directory" },
  { test: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i, what: "a private SSH key" },
  { test: /\.pem$/i, what: "a private key file" },
  { test: /(^|\/)(secrets?|credentials)(\/|\.|$)/i, what: "a secrets/credentials file" },
];

/**
 * If `absPath` is a file the agent must never touch, return a short reason;
 * otherwise null. `absPath` may use either slash style.
 */
export function protectedPathReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  for (const { test, what } of PROTECTED_PATTERNS) {
    if (test.test(posix)) return what;
  }
  return null;
}

// Irreversible, essentially-never-legitimate commands. Patterns are intentionally
// narrow (high precision) so they don't get in the way of real work — the goal is
// to catch the catastrophic mistake, not to police the shell.
const CATASTROPHIC_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\s|$)/i, what: "recursively deleting the filesystem root or home directory" },
  { test: /\b(mkfs|format)\b/i, what: "reformatting a disk" },
  { test: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, what: "overwriting a raw disk device" },
  { test: />\s*\/dev\/(sd|nvme|disk|hd)/i, what: "writing to a raw disk device" },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: "a fork bomb" },
  { test: /\bRemove-Item\b[^\n]*\b-Recurse\b[^\n]*(\\|\/|\$env:|~)(\s|$)/i, what: "recursively deleting a drive root or home directory" },
];

/**
 * If `command` is an irreversible, catastrophic action, return a short reason;
 * otherwise null.
 */
export function catastrophicCommandReason(command: string): string | null {
  for (const { test, what } of CATASTROPHIC_PATTERNS) {
    if (test.test(command)) return what;
  }
  return null;
}
