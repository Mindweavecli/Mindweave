/**
 * detail.ts — display-only rich detail for mutating tools.
 *
 * Builds the multi-line block the UI shows under a tool row: a +/- diff for an
 * edit, a preview of a freshly written file, or a command's output. This is
 * `ToolResult.detail` — it never reaches the model (the model gets the terse
 * `output`), it only makes the terminal show what actually happened —
 * a diff or a command's stdout. Lines are prefixed so the
 * renderer can colour them: `+ ` added (green), `- ` removed (red), bare = plain.
 */

/** Cap a list of display lines, noting how many were hidden. */
export function capLines(lines: string[], max: number): string {
  if (lines.length <= max) return lines.join("\n");
  const hidden = lines.length - max;
  return [...lines.slice(0, max), `  … (${hidden} more line${hidden === 1 ? "" : "s"})`].join("\n");
}

// ── Scope helpers (pure) — the "what/where/how much" a change touched, so the row
// isn't just a diff with no sense of range or magnitude. Kept pure + tested.

/** Lines a replacement string spans (an empty string spans none). */
export function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

/** A line-range label: "L120" for one line, "L120-138" for a span. */
export function rangeLabel(startLine: number, endLine: number): string {
  return endLine > startLine ? `L${startLine}-${endLine}` : `L${startLine}`;
}

/** The change magnitude, "−6 +12" — a real minus sign (U+2212), never the diff's
 *  hyphen, so it can't be mistaken for a removed line. */
export function magnitude(removed: number, added: number): string {
  return `−${removed} +${added}`;
}

/** Prepend a dim scope header above a diff/preview (its own line, no +/- prefix so
 *  the renderer leaves it uncolored). Empty `body` → just the header. */
export function withScope(scope: string, body: string): string {
  return body ? `${scope}\n${body}` : scope;
}

/** A +/- diff for an edit: the replaced lines removed, the new lines added. */
export function editDetail(oldStr: string, newStr: string): string {
  const lines = [
    ...stripTrailingNewline(oldStr).split("\n").map((l) => `- ${l}`),
    ...stripTrailingNewline(newStr).split("\n").map((l) => `+ ${l}`),
  ];
  return capLines(lines, 30);
}

/** A stacked +/- diff for a sequence of edits (multi_edit), one block per edit. */
export function multiEditDetail(edits: { oldString: string; newString: string }[]): string {
  const lines: string[] = [];
  for (const e of edits) {
    lines.push(...stripTrailingNewline(e.oldString).split("\n").map((l) => `- ${l}`));
    lines.push(...stripTrailingNewline(e.newString).split("\n").map((l) => `+ ${l}`));
  }
  return capLines(lines, 30);
}

/** A preview of a newly created file — all additions. */
export function writeDetail(content: string): string {
  if (content === "") return "";
  return capLines(stripTrailingNewline(content).split("\n").map((l) => `+ ${l}`), 20);
}

/** A command's output for inline display (plain lines, no diff prefixes). */
export function outputDetail(body: string): string {
  if (!body) return "";
  return capLines(body.split("\n"), 18);
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
