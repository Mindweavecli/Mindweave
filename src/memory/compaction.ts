/**
 * compaction.ts — keeping the model sharp as a session grows (pure half).
 *
 * A long transcript hurts two ways: the live task gets buried under stale tool
 * output (a coding model "loses its moment" well before any hard context limit —
 * multi-needle retrieval, which is what recalling a long session actually is,
 * sags long before the storage cap), and on BYOK every wasted token is the
 * user's money. The per-model sharp windows live in the drivers.
 * The cascade, cheapest first:
 *
 *   1. MICROCOMPACT (no model call, lossless): once the transcript passes a low
 *      bar, clear the BODIES of old tool results — keep the last N verbatim — so
 *      the recent working set stays dense. The model can always re-read; a
 *      cleared result leaves a stub saying so. Fires early and often.
 *   2. AUTOCOMPACT (one model call): the backstop. When microcompact can't keep
 *      the transcript under the higher bar, replace the old prefix with a
 *      9-section structured summary and keep the last N turns verbatim. The
 *      engine pairs this with re-reading the working-set files (restoration) so
 *      nothing the model was mid-edit on is lost.
 *
 * This module is PURE — estimation, the microcompact transform, the summary
 * prompt, and the splice. It does no I/O and makes no model calls (the engine
 * owns "when" and the summarizer call), so it stays trivially testable and could
 * run on either side of the future client/server line.
 */
import type { Entry } from "./types.js";

// ~3.5 chars/token, deliberately tokenizer-free: triggers need a cheap, stable,
// slightly-conservative proxy, not an exact count (better to compact a touch
// early than to overflow).
const CHARS_PER_TOKEN = 3.5;

// The BARS themselves live in `dynamo/contextWindow.ts` and are derived from the
// driver's sharp window, so they move with the model instead of being frozen here.
// This module used to also export fixed MICROCOMPACT_TOKENS / AUTOCOMPACT_TOKENS
// constants; nothing read them once the engine went model-anchored, and their
// doc comment went on asserting 45K/90K while the live bars were 38K/95K. Deleted
// rather than corrected: a second source of truth for the same number is the
// stale-claim trap in BOUNDARY.md. The env overrides
// (MINDWEAVE_MICROCOMPACT_TOKENS / MINDWEAVE_AUTOCOMPACT_TOKENS) are unaffected —
// the engine reads them directly at the point of use.

/** Tool observations kept verbatim; older ones get their body cleared. Kept deliberately
 *  tight — a weaker model regresses on stale tool noise sooner, so we keep less. */
export const KEEP_LAST_N = 8;

/** At a TASK BOUNDARY (a finished task, a new request) we sweep hard: keep only this
 *  many recent observations, since the finished task's detail is no longer load-bearing. */
export const KEEP_LAST_N_BOUNDARY = 2;

const CLEARED_STUB = "[old tool result cleared to save context — re-read the file/search if you need it again]";

/** Old assistant prose (a "here's what I built" recap) is what a weaker model latches
 *  onto and regresses to. Beyond the recent window we condense these to a stub so a
 *  finished task can't resurface. Only pure-text replies (no tool calls) and only
 *  genuine recaps (long enough) are touched — short acknowledgements stay. */
const RECAP_STUB = "[earlier status update condensed — this work is done; focus on the current task]";
const RECAP_MIN_CHARS = 220;

/** Edit/write tools whose call INPUT carries bulky content (a whole file, a diff, a
 *  symbol body). Once such an edit is old and its result already cleared, the content
 *  it wrote is dead weight — the live file is in the working set or a re-read away — so
 *  we clear the input too. Done here on the transcript, this is provider-AGNOSTIC —
 *  every model, not just DeepSeek, gets the saving, and it stays correct even once a
 *  provider offers an equivalent feature natively. */
const CONTENT_CARRYING_TOOLS = new Set(["edit_file", "write_file", "multi_edit", "replace_symbol_body"]);

const CLEARED_INPUT_NOTE =
  "content cleared to save context — the file's current state is in the working set, or re-read it";

/** Shrink a mutation tool-call's arguments to just its identifying fields (which file
 *  or symbol), dropping the bulky payload. Returns null when there's nothing to do —
 *  malformed JSON, or already cleared (idempotent). Keeps valid JSON so the call stays
 *  well-formed on the wire for every provider. */
function clearMutationArgs(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj._cleared) return null;
  const kept: Record<string, unknown> = {};
  for (const key of ["path", "symbol", "name"] as const) {
    if (typeof obj[key] === "string") kept[key] = obj[key];
  }
  kept._cleared = CLEARED_INPUT_NOTE;
  return JSON.stringify(kept);
}

/** Cheap token estimate for a string. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) + 1 : 0;
}

/** Estimated token footprint of a transcript (content + tool-call arguments + small overhead). */
export function estimateEntriesTokens(entries: Entry[]): number {
  let total = 0;
  for (const e of entries) {
    total += estimateTokens(e.content) + 4;
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) total += estimateTokens(tc.arguments) + estimateTokens(tc.name);
    }
  }
  return total;
}

/**
 * Layer 1: clear the bodies of OLD tool results, keeping the last `keepLastN`
 * intact. Pure — returns a new transcript and how many were cleared.
 *
 * What it must never touch: user/assistant messages (the actual conversation),
 * the last N tool results (the live working set), and any tool result that
 * hasn't been superseded by a newer assistant tool-call round (the model has not
 * even seen those yet). An already-cleared stub is left alone (idempotent).
 */
export function microcompact(
  entries: Entry[],
  keepLastN: number = KEEP_LAST_N,
): { entries: Entry[]; cleared: number; clearedIds: string[]; recapsCleared: number; inputsCleared: number } {
  const toolIdx = entries.flatMap((e, i) => (e.role === "tool" ? [i] : []));
  let clearable = new Set(keepLastN > 0 ? toolIdx.slice(0, -keepLastN) : toolIdx);

  // Never clear the most recent tool round — the results after the last
  // assistant tool-call are fresh reads the model hasn't acted on yet.
  let lastRoundStart = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role === "assistant" && e.toolCalls && e.toolCalls.length > 0) lastRoundStart = i;
  }
  if (lastRoundStart >= 0) {
    clearable = new Set([...clearable].filter((i) => i < lastRoundStart));
  }

  // Which edit/write tool-call INPUTS to clear: map each clearable RESULT back to the
  // call that produced it; if that call was a content-carrying edit/write, its input is
  // dead weight now too. Keyed off the SAME clearable window, so recent edits stay whole.
  const callNameById = new Map<string, string>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) for (const tc of e.toolCalls) callNameById.set(tc.id, tc.name);
  }
  const clearInputIds = new Set<string>();
  for (const i of clearable) {
    const e = entries[i];
    if (e && e.role === "tool") {
      const name = callNameById.get(e.toolCallId);
      if (name && CONTENT_CARRYING_TOOLS.has(name)) clearInputIds.add(e.toolCallId);
    }
  }

  // Old assistant recaps are condensed beyond the recent window — this is what stops a
  // finished task from resurfacing. Recent replies (last keepLastN entries) are kept.
  const recapBoundary = Math.max(0, entries.length - keepLastN);

  let cleared = 0;
  let recapsCleared = 0;
  let inputsCleared = 0;
  const clearedIds: string[] = [];
  const out = entries.map((e, i) => {
    // 1) Old tool-result bodies → stub (with first line kept for navigation).
    if (clearable.has(i) && e.role === "tool") {
      if (e.content.includes(CLEARED_STUB)) return e; // already cleared
      cleared++;
      clearedIds.push(e.toolCallId); // so the caller can drop the file from the read ledger
      const firstLine = e.content.split("\n", 1)[0]?.trim() ?? "";
      const stub = firstLine && firstLine.length < 120 ? `${firstLine}\n${CLEARED_STUB}` : CLEARED_STUB;
      return { ...e, content: stub };
    }
    // 2) Old standalone assistant recaps → stub (pure text, no tool calls, long enough).
    if (
      i < recapBoundary &&
      e.role === "assistant" &&
      !(e.toolCalls && e.toolCalls.length > 0) &&
      e.content.length >= RECAP_MIN_CHARS &&
      e.content !== RECAP_STUB
    ) {
      recapsCleared++;
      return { ...e, content: RECAP_STUB };
    }
    // 3) Old edit/write tool-call INPUTS → shrunk to just which file, dropping the
    //    content payload. Its paired result is already being cleared above.
    if (e.role === "assistant" && e.toolCalls && e.toolCalls.some((tc) => clearInputIds.has(tc.id))) {
      const toolCalls = e.toolCalls.map((tc) => {
        if (!clearInputIds.has(tc.id)) return tc;
        const shrunk = clearMutationArgs(tc.arguments);
        if (shrunk == null) return tc;
        inputsCleared++;
        return { ...tc, arguments: shrunk };
      });
      return { ...e, toolCalls };
    }
    return e;
  });

  if (cleared === 0 && recapsCleared === 0 && inputsCleared === 0) {
    return { entries: [...entries], cleared: 0, clearedIds: [], recapsCleared: 0, inputsCleared: 0 };
  }
  return { entries: out, cleared, clearedIds, recapsCleared, inputsCleared };
}

// Trivial continuations that do NOT open a new task — so a "continue"/"yes" after a
// finished task doesn't trigger a task-boundary sweep (there's no new task to make
// room for; the model is resuming the same one). Pure.
const CONTINUATION_RE =
  /^(continue|keep going|go on|go ahead|proceed|resume|yes|yep|yeah|yup|ok|okay|sure|next|do it|carry on|and\b|also\b)/i;

/** Whether a new user message is a trivial continuation rather than a new task. */
export function isContinuation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // A short affirmation/continuation; a long message is treated as a real new request.
  return t.length <= 40 && CONTINUATION_RE.test(t);
}

// The 9-section structured summary. NOT "summarize this" — a forced structure
// that preserves intent, the code touched and why, errors already fixed, and a
// verbatim next step, so the loop resumes across the boundary as if nothing
// happened.
export const SUMMARY_SYSTEM_PROMPT =
  "You are compacting a software-engineering conversation so it can continue " +
  "without losing context. Produce a STRUCTURED summary — not a paragraph. Be " +
  "precise and concrete; this summary REPLACES the older transcript, so anything " +
  "you omit is gone.";

export const SUMMARY_REQUEST = `Summarize the conversation so far into these nine numbered sections, in order:

1. Primary Request & Intent — what the user is ultimately trying to build or solve, in their own framing.
2. Key Technical Concepts — frameworks, patterns, files, and decisions that matter.
3. Files & Code — every file touched or discussed, with the relevant snippet(s) AND why each matters. Keep code that future edits depend on.
4. Errors & Fixes — each error hit and how it was resolved, so it is not repeated.
5. Problem Solving — approaches tried, what worked, what was ruled out.
6. All User Messages — list every non-tool message the user sent, as close to verbatim as possible.
7. Pending Tasks — what still needs doing.
8. Current Work — exactly what was happening right before this summary, including the specific file/line/command in flight.
9. Next Step — the single most likely next action; quote the relevant user instruction verbatim so intent does not drift.

Think first inside <analysis>…</analysis> (which will be discarded), then output the nine sections.`;

// Prepended to the summary when the compacted transcript resumes, so the model
// continues seamlessly instead of narrating that a summary happened.
const RESUME_PREFIX =
  "[Earlier conversation summarized to save context. Continue as if the break " +
  "never happened — do not acknowledge the summary or recap it.]\n\n";

/** Render a transcript into plain text for the summarizer's single user turn. */
export function formatTranscriptForSummary(entries: Entry[]): string {
  return entries
    .map((e) => {
      if (e.role === "tool") return `=== TOOL RESULT ===\n${e.content}`;
      if (e.role === "assistant") {
        const calls = e.toolCalls?.length
          ? `\n[called: ${e.toolCalls.map((c) => c.name).join(", ")}]`
          : "";
        return `=== ASSISTANT ===\n${e.content}${calls}`;
      }
      return `=== ${e.role.toUpperCase()} ===\n${e.content}`;
    })
    .join("\n\n");
}

/** Strip the model's <analysis> scratchpad, keeping only the nine sections. */
export function stripAnalysis(summary: string): string {
  return summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
}

/**
 * Layer 2 apply: replace the old prefix with the summary, keep the last
 * `keepLastN` entries verbatim. Pure.
 *
 * The kept tail must start on a clean boundary — a `tool` entry is only valid
 * immediately after the assistant `toolCalls` that produced it, so if the cut
 * lands mid-round we drop the orphaned leading tool results (their parent turn
 * is captured in the summary). The discriminated union makes this check exhaustive.
 */
export function spliceSummary(
  entries: Entry[],
  summary: string,
  keepLastN: number = KEEP_LAST_N,
): Entry[] {
  let tail = keepLastN > 0 ? entries.slice(-keepLastN) : [];
  while (tail.length > 0 && tail[0].role === "tool") tail = tail.slice(1);
  const summaryEntry: Entry = { role: "summary", content: RESUME_PREFIX + stripAnalysis(summary) };
  return [summaryEntry, ...tail];
}
