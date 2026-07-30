/**
 * focus.ts — pure helpers for a file's "focus spans": the line ranges the model has
 * recently read or edited. When a file is too big to keep whole in the working set,
 * these spans are what we show (its focused regions) instead of the entire file.
 *
 * Kept dependency-free so both the path/ledger layer (paths.ts) and the working-set
 * renderer (workingSet.ts) can share it without an import cycle.
 */

export interface FocusSpan {
  start: number; // 1-based, inclusive
  end: number;
}

/**
 * Add a span to a file's focus list, merging overlapping/adjacent ranges and keeping
 * at most `max` (the most recent). Returns a new array (or undefined when nothing to
 * track). Pure.
 */
export function addFocus(
  existing: FocusSpan[] | undefined,
  span: FocusSpan | undefined,
  max = 4,
): FocusSpan[] | undefined {
  if (!span) return existing;
  const all = [...(existing ?? []), { start: Math.max(1, span.start), end: Math.max(span.start, span.end) }].sort(
    (a, b) => a.start - b.start,
  );
  const merged: FocusSpan[] = [];
  for (const s of all) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  // Keep the most recent (highest-line) spans when over the cap.
  return merged.slice(-max);
}
