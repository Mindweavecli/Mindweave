/**
 * approval.ts — the forbidden-path lift.
 *
 * When a protected (forbidden) path blocks a write/edit/run, the model shouldn't
 * just hit a wall: it asks the human. Through the client's approval channel
 * (`ctx.requestApproval`) the user gets Yes / No / "let me tell you what to do".
 *   - Yes   → the path is lifted FOR THIS SESSION (removed from the in-memory
 *             deny-list, so the rest of the run proceeds without re-asking; the
 *             saved rule on disk is untouched, so it returns next session).
 *   - No    → the original refusal stands; the model adapts.
 *   - Defer → control goes back to the user to give direction in the chat.
 *
 * With no approval channel (tests, or a future headless server) it falls back to
 * the hard refusal — fail-closed, exactly as before.
 */
import type { ToolContext, ToolResult } from "./types.js";

const ALLOW = "Yes, allow it this time";
const DENY = "No, keep it protected";
const DEFER = "Let me tell you what to do";

/**
 * Offer to lift a forbidden path. Returns `null` to proceed (the user allowed it),
 * or a ToolResult the caller should return (refused or deferred). `refusal` is the
 * message used when there's no channel to ask through.
 */
export async function requestForbiddenLift(
  ctx: ToolContext,
  pattern: string,
  action: string,
  refusal: string,
  noun = "protected path",
): Promise<ToolResult | null> {
  if (!ctx.requestApproval) {
    return { output: `Error: ${refusal}`, isError: true, summary: `refused (forbidden '${pattern}')` };
  }

  const choice = await ctx.requestApproval(
    `This is blocked by a ${noun} rule ('${pattern}'). Allow ${action} anyway?`,
    [ALLOW, DENY, DEFER],
  );

  if (choice === ALLOW) {
    liftForbidden(ctx, pattern);
    return null; // proceed
  }
  if (choice === DEFER) {
    return {
      output: `Stopped: '${pattern}' is protected. The user will tell you how to proceed — wait for their direction instead of touching it.`,
      isError: true,
      summary: `awaiting direction on '${pattern}'`,
    };
  }
  return {
    output: `Refused: '${pattern}' is protected and the user declined to lift it. Find another way that doesn't touch it.`,
    isError: true,
    summary: `'${pattern}' kept protected`,
  };
}

/** Drop a pattern from the live (session-only) deny-list. A new object forces the
 *  matcher to recompile; the on-disk rule is left intact. */
function liftForbidden(ctx: ToolContext, pattern: string): void {
  const g = ctx.governance;
  if (!g) return;
  // Filter BOTH lists: a lift may be for a forbidden path or a forbidden command,
  // and a pattern won't collide across the two, so dropping it from each is safe.
  g.forbidden = {
    ...g.forbidden,
    patterns: g.forbidden.patterns.filter((p) => p !== pattern),
    commands: (g.forbidden.commands ?? []).filter((c) => c !== pattern),
  };
}
