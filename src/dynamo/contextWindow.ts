/**
 * contextWindow.ts — model-anchored compaction thresholds (pure).
 *
 * Compaction is anchored to the model's REAL context window rather than a fixed
 * number: reserve room for the summary output plus a safety buffer, then compact
 * when usage crosses what's left. That keeps the thresholds correct per model, and
 * automatically right when a stronger or longer model is wired in, instead of a
 * single hard-coded ceiling.
 *
 * The window itself is the driver's answer, and it is each model's SHARP window —
 * the span where attention stays reliable — not its storage maximum. A model that
 * stores 1M tokens can still degrade from tool-noise dilution long before that, and
 * on BYOK every token is the user's money, so compacting to the sharp window is
 * both more accurate and cheaper. This module owns only the arithmetic on top.
 */
import { manifestForModel } from "../drivers/registry.js";

/** Reserved for the compaction summary's own output. */
const SUMMARY_RESERVE = 20_000;
/** Headroom below the window so a turn's growth can't blow past it. */
const COMPACT_BUFFER = 13_000;

/** The model's usable context window, as its driver reports it. */
export function sharpContextWindow(model: string): number {
  return manifestForModel(model).contextWindow(model);
}

/**
 * Autocompact bar for a given window: summarize once the transcript crosses
 * (window − summary reserve − buffer). For a 256K sharp window that's ~223K.
 */
export function autoBarFor(window: number): number {
  return Math.max(20_000, window - SUMMARY_RESERVE - COMPACT_BUFFER);
}

/**
 * Microcompact bar for a given window: clear old tool-result bodies well before
 * the autocompact bar, so the working set stays lean continuously rather than only
 * at the summary point. 30% of the window (~77K on a 256K model).
 */
export function microBarFor(window: number): number {
  return Math.round(window * 0.3);
}

/** Autocompact bar for a model, anchored to its driver's window. */
export function autoCompactThreshold(model: string): number {
  return autoBarFor(sharpContextWindow(model));
}

/** Microcompact bar for a model, anchored to its driver's window. */
export function microCompactThreshold(model: string): number {
  return microBarFor(sharpContextWindow(model));
}
