/**
 * editCore.ts — the pure matching/splice logic shared by edit_file and multi_edit.
 *
 * One source of truth for HOW an exact find-and-replace is applied, kept pure
 * (string in, string out — no fs, no EOL handling) so it's unit-tested once and
 * both tools inherit the same guarantees: exact matching, must-exist, and
 * unique-match-unless-replace_all. The tools wrap it with the disk/EOL/approval
 * concerns; deciding WHAT to change stays the model's job.
 */

export interface EditOp {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** A successful splice on normalized (LF) text. */
export interface EditApplied {
  ok: true;
  /** The whole text after the edit (still LF-normalized). */
  updated: string;
  /** How many occurrences were replaced. */
  count: number;
  /** Char offset where the (first) change landed, and where it ends. */
  changeStart: number;
  changeEnd: number;
}

export type EditResult = EditApplied | { ok: false; reason: string };

/** Normalize CRLF → LF so a model's LF `old_string` matches a CRLF file. */
export function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Apply one exact edit to already-LF-normalized `text`. The `oldString`/`newString`
 * are normalized here too. Returns the updated text and where the change landed, or
 * a `reason` describing why it couldn't apply (identical / not found / ambiguous).
 * Splices by index so a `$` in the replacement is never a special pattern.
 */
export function applyOneEdit(text: string, op: EditOp): EditResult {
  // Normalize BOTH sides to LF: the file on disk may be CRLF while the model's
  // old_string (copied from LF text it was shown) is LF. This is a representation
  // fix, not fuzzy matching — whitespace and indentation still match exactly.
  const haystack = normalizeLf(text);
  const needle = normalizeLf(op.oldString);
  const replacement = normalizeLf(op.newString);

  if (needle === "") return { ok: false, reason: "old_string is empty — it must identify the text to replace" };
  if (needle === replacement) return { ok: false, reason: "old_string and new_string are identical — nothing to change" };

  const count = occurrences(haystack, needle);
  if (count === 0) {
    return {
      ok: false,
      reason:
        "old_string not found — it must match exactly, including whitespace and indentation. " +
        "Re-read the file and copy the target text precisely",
    };
  }
  if (count > 1 && !op.replaceAll) {
    return {
      ok: false,
      reason:
        `old_string matches ${count} places — add surrounding lines to make it unique, ` +
        "or set replace_all to change all of them",
    };
  }

  let updated: string;
  let changeStart: number;
  if (op.replaceAll) {
    updated = haystack.split(needle).join(replacement);
    changeStart = updated.indexOf(replacement);
  } else {
    const at = haystack.indexOf(needle);
    updated = haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
    changeStart = at;
  }
  const changeEnd = (changeStart < 0 ? 0 : changeStart) + replacement.length;
  return { ok: true, updated, count, changeStart, changeEnd };
}

/** The outcome of applying a whole sequence of edits to one file. */
export interface SequenceApplied {
  ok: true;
  updated: string;
  /** Total replacements across all edits. */
  total: number;
  /** Char span (in the final text) from the first edit's start to the last edit's end. */
  spanStart: number;
  spanEnd: number;
}

export type SequenceResult = SequenceApplied | { ok: false; index: number; reason: string };

/**
 * Apply edits in order to normalized `text`, each seeing the result of the one
 * before (so a later edit can target text an earlier edit produced). ATOMIC: the
 * first failure aborts the whole sequence with the offending edit's index and
 * reason — the caller writes nothing, so a file is never left half-edited.
 */
export function applyEditSequence(text: string, ops: EditOp[]): SequenceResult {
  let current = normalizeLf(text);
  let total = 0;
  let spanStart = -1;
  let spanEnd = 0;
  for (let i = 0; i < ops.length; i++) {
    const r = applyOneEdit(current, ops[i]!);
    if (!r.ok) return { ok: false, index: i, reason: r.reason };
    current = r.updated;
    total += r.count;
    if (spanStart < 0 && r.changeStart >= 0) spanStart = r.changeStart;
    spanEnd = Math.max(spanEnd, r.changeEnd);
  }
  return { ok: true, updated: current, total, spanStart: Math.max(0, spanStart), spanEnd };
}
