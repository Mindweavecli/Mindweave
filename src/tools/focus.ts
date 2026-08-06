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

/**
 * Is [start..end] wholly inside a span the model is already being shown?
 *
 * The working set renders a large file's focus regions every turn, so a symbol inside
 * one of them is already in context and re-sending it pays twice. Checked against the
 * focus recorded BEFORE this read, and only ever used together with an unchanged-file
 * check — a stale region is worse than a duplicated one.
 */
export function coversSpan(focus: FocusSpan[] | undefined, start: number, end: number): boolean {
  return (focus ?? []).some((f) => f.start <= start && f.end >= end);
}
