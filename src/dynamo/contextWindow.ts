/**
 * contextWindow.ts — model-anchored context thresholds (pure).
 *
 * Compaction is anchored to the model's REAL context window rather than a fixed
 * number: reserve room for the summary output and a safety buffer, then compact when
 * usage crosses what's left. This keeps the thresholds correct per model (and
 * automatically right when stronger/longer models are wired in) instead of a single
 * hard-coded 90K.
 *
 * A deliberate choice: we anchor to each model's SHARP window — the
 * span where attention stays reliable — not its storage maximum. DeepSeek stores 1M
 * tokens but degrades from tool-noise dilution well before that (~128K), and on BYOK
 * every token is the user's money, so compacting to the sharp window is both more
 * accurate and cheaper. We also run microcompact earlier and keep the working set
 * tighter, because a weaker model regresses on stale context sooner.
 */

/** Reserved for the compaction summary's own output (~20K). */
const SUMMARY_RESERVE = 20_000;
/** Headroom below the window so a turn's growth can't blow past it (~13K). */
const COMPACT_BUFFER = 13_000;

/**
 * The model's SHARP context window — where retrieval + attention stay reliable, not
 * the raw storage cap. Keyed by family so a newly-wired model gets a sane default.
 */
export function sharpContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 200_000;
  if (/gpt|o1|o3|gemini/.test(m)) return 128_000;
  // DeepSeek (and unknown default): 1M stored, but ~128K before noise dilution bites.
  return 128_000;
}

/**
 * Autocompact bar: summarize once the transcript crosses (window − summary reserve −
 * buffer). For DeepSeek's 128K sharp window that's ~95K.
 */
export function autoCompactThreshold(model: string): number {
  return Math.max(20_000, sharpContextWindow(model) - SUMMARY_RESERVE - COMPACT_BUFFER);
}

/**
 * Microcompact bar: clear old tool-result bodies well before the autocompact bar, so
 * the working set stays lean continuously rather than only at the summary point. ~30%
 * of the sharp window (~38K on DeepSeek) — earlier and tighter to keep context lean.
 */
export function microCompactThreshold(model: string): number {
  return Math.round(sharpContextWindow(model) * 0.3);
}
