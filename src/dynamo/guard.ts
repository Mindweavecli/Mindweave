/**
 * guard.ts — the pure decision logic for Sentinel mode (ask-before-acting).
 *
 * Sentinel gates every MUTATING tool call behind a human yes/no in the CLI. The
 * mechanics live in the engine's tool-execution choke point; this module holds only
 * the parts worth unit-testing: how a call is described to the user, the three
 * choices offered, and how the chosen answer maps to an action. Keeping it pure
 * means the gate's behavior is verified, not blind-shipped — and the engine stays
 * mode-agnostic (it acts on the decision, never on a mode name).
 */

/** The three answers a Sentinel prompt offers, in order. */
export const GUARD_OPTIONS = [
  "Yes, do it",
  "Yes, and stop asking this session",
  "No — let me tell you what to do",
] as const;

export type GuardDecision = "proceed" | "allow-all" | "refuse";

/**
 * Map the user's chosen option to an action. Anything unrecognized — including a
 * cancel/Esc (the overlay resolves those to a decline) — is treated as `refuse`, so
 * the gate fails safe: an unclear answer never runs the action.
 */
export function interpretGuardChoice(choice: string | undefined): GuardDecision {
  if (choice === GUARD_OPTIONS[0]) return "proceed";
  if (choice === GUARD_OPTIONS[1]) return "allow-all";
  return "refuse";
}

/** What the model is told when the user declines an action in Sentinel mode. */
export const GUARD_REFUSAL =
  "Stopped: the user declined this action in Sentinel mode. Do not retry it — briefly say what you " +
  "were about to do and wait for the user's direction on how to proceed.";

/** A short, human-readable description of a mutating call, for the approval prompt. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  switch (name) {
    case "edit_file":
    case "write_file":
    case "multi_edit":
    case "replace_symbol_body":
      return `${name} — ${path ?? "?"}`;
    case "run_command":
      return `run_command — ${clip(strArg(args.command), 80)}`;
    case "spawn_subagent":
      return `spawn_subagent — ${clip(strArg(args.task), 80)}`;
    default:
      // Anything else: the name, plus a path if the call carries one.
      return path ? `${name} — ${path}` : name;
  }
}

/** The question shown atop the Sentinel approval prompt. */
export function guardQuestion(name: string, args: Record<string, unknown>): string {
  return `Sentinel — approve this action?\n${describeCall(name, args)}`;
}

function strArg(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
