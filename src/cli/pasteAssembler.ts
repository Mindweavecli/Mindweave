/**
 * pasteAssembler.ts — reassembles a bracketed paste that the terminal delivers as
 * several input chunks.
 *
 * When bracketed paste is enabled (`\x1b[?2004h`), a paste is wrapped in `\x1b[200~`
 * … `\x1b[201~` markers. A large paste still arrives split across several `input`
 * events (~1KB each), with the start marker on the first chunk and the end marker on
 * the last — so we must track state across chunks and accumulate until the end.
 *
 * Ink's `parseKeypress` mangles the markers: it strips a leading ESC from a
 * start-of-chunk sequence, so `\x1b[200~` reaches us as `[200~`, while a mid-chunk
 * `\x1b[201~` keeps its ESC. We therefore match both markers ESC-optionally.
 *
 * This module is pure and synchronous so the state machine can be unit-tested without
 * mounting the terminal UI. The timing-based fallback for terminals that lack
 * bracketed paste stays in the component (it needs real timers).
 */

// Match the paste markers whether or not Ink left the leading ESC on.
export const PASTE_START_RE = /\x1b?\[200~/;
export const PASTE_END_RE = /\x1b?\[201~/;

export interface PasteState {
  /** True once the start marker has been seen and before the end marker. */
  active: boolean;
  /** Content accumulated so far across chunks. */
  buf: string;
}

export type PasteStep =
  /** This chunk isn't part of a paste; the caller should handle `input` normally. */
  | { kind: "passthrough" }
  /** The chunk was consumed into the paste, which isn't finished yet. */
  | { kind: "buffering"; state: PasteState }
  /** The paste finished; `text` is the full content (markers stripped). */
  | { kind: "flush"; text: string };

export function initPasteState(): PasteState {
  return { active: false, buf: "" };
}

/**
 * Feed one raw input chunk. Returns what the caller should do. On `flush` the caller
 * inserts `text` (as a chip if large); the state should be reset afterward.
 */
export function feedPasteChunk(state: PasteState, input: string): PasteStep {
  const starting = PASTE_START_RE.test(input);
  if (!state.active && !starting) {
    return { kind: "passthrough" };
  }
  // Strip a start marker (only present on the first chunk) and detect the end marker.
  let text = input.replace(PASTE_START_RE, "");
  const ending = PASTE_END_RE.test(text);
  text = text.replace(PASTE_END_RE, "");
  const buf = state.buf + text;
  if (ending) {
    // A split end marker can leave a stray trailing ESC; drop it.
    return { kind: "flush", text: buf.replace(/\x1b$/, "") };
  }
  return { kind: "buffering", state: { active: true, buf } };
}
