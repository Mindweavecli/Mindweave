/**
 * toolItems.ts — pure helpers for rendering a list of tool "items" (the entries in
 * a discovery group or a sub-agent rail). Kept free of React so it's unit-testable.
 *
 * Two jobs:
 *  - itemLabel: what one item reads as, live ("Reading home.html") then resolved
 *    ("Read home.html (1747 lines)").
 *  - collapseAdjacent: fold a RUN of identical consecutive items into one line with a
 *    ×N count. This is the "collide the same silent thing when it repeats" rule — the
 *    fix for a model that polls `shell_output` (or re-reads one file) over and over:
 *    nine `shell #1 (running)` rows become one `shell #1 (running) ×9`. Only identical
 *    ADJACENT items merge, so distinct calls still each show; and only silent/groupable
 *    tools ever land here — an edit diff or a command's output always keeps its own row.
 */
import type { ToolGroupItem } from "./transcript.js";

// Present-continuous verb shown while a call is still running, so a row reads
// "Reading home.html" live and then resolves to "Read home.html (1747 lines)".
export const ACTIVE_FORM: Record<string, string> = {
  Read: "Reading",
  Search: "Searching",
  Glob: "Finding",
  List: "Listing",
  Map: "Mapping",
  Fetch: "Fetching",
  Shell: "Checking",
  Check: "Checking",
};

/** What a discovery/rail item shows: while it runs, a present-tense line ("Reading
 *  home.html"); once it resolves, its tool-authored result ("Read home.html (1747
 *  lines)"), capitalized for the list. Falls back to name + argument if there's no
 *  result. */
export function itemLabel(it: ToolGroupItem): string {
  if (it.status === "running") {
    const verb = ACTIVE_FORM[it.name] ?? it.name;
    return it.arg ? `${verb} ${it.arg}` : verb;
  }
  if (it.note) return it.note.charAt(0).toUpperCase() + it.note.slice(1);
  return it.arg ? `${it.name} ${it.arg}` : it.name;
}

/** One display row after collapsing: the representative item (latest, for status/kind),
 *  its label, and how many identical calls it stands for. */
export interface CollapsedItem {
  item: ToolGroupItem;
  label: string;
  count: number;
  anyError: boolean;
}

/**
 * Fold consecutive items with the SAME label into one row carrying a count. Adjacent
 * only — a different call in between breaks the run — so this never hides distinct
 * work, it only silences a repeated poll/read. The representative keeps the latest
 * item (so status reflects the most recent), and any error in the run is remembered.
 */
export function collapseAdjacent(items: ToolGroupItem[]): CollapsedItem[] {
  const out: CollapsedItem[] = [];
  for (const it of items) {
    const label = itemLabel(it);
    const last = out[out.length - 1];
    if (last && last.label === label) {
      last.count += 1;
      last.item = it;
      if (it.status === "error") last.anyError = true;
    } else {
      out.push({ item: it, label, count: 1, anyError: it.status === "error" });
    }
  }
  return out;
}
