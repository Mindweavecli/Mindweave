/**
 * reveal.ts — the pure decision for HOW to reveal a tool row.
 *
 * The old behavior revealed a tool the instant it started (a bare `● Run(cmd)`
 * header) and only expanded its output — the `⎿` block — later, when the result
 * landed. That reads as a two-step "header, then pop": jarring, and worse in a
 * burst where every header shows first and every body expands at once.
 *
 * Instead we prefer to reveal a row ALREADY RESOLVED (header + output together, in
 * one step). A just-started tool is held for a short grace window: if it finishes
 * within it, the row appears complete; only a genuinely slower tool (still running
 * after the grace) falls back to a running header so it never looks frozen. This
 * function is the whole policy — pure, so it can be unit-tested away from timers.
 */

/** How long to hold a just-started tool before showing a running header, giving a
 *  fast tool the chance to finish so its row can appear already-resolved. Tunable. */
export const TOOL_GRACE_MS = 350;

export type ToolRevealPlan =
  | "resolved" // its result is in hand — reveal the row complete, in one step
  | "running" // still going (grace elapsed, or we're flushing) — show a running header
  | "hold"; // not done yet, still within grace — wait a beat for it to resolve

/**
 * Decide how to reveal a tool row.
 *  - result already available → "resolved" (the row appears complete at once).
 *  - flushing (Esc: drain with no pacing) and not resolved → "running" now.
 *  - still within the grace window → "hold" (come back once it resolves or grace ends).
 *  - grace elapsed and still running → "running" (a running header, expands later).
 */
export function planToolReveal(
  endAvailable: boolean,
  heldMs: number,
  graceMs: number,
  flush: boolean,
): ToolRevealPlan {
  if (endAvailable) return "resolved";
  if (flush) return "running";
  return heldMs >= graceMs ? "running" : "hold";
}
