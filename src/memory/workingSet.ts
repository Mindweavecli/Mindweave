/**
 * workingSet.ts — the live "working set": the files the model is actively working on,
 * kept CURRENT in the volatile context tail every turn.
 *
 * This is the fix for the re-read storm. Instead of leaving file reads in the
 * transcript (where they go stale after an edit and get cleared by compaction — so the
 * model re-reads and "forgets"), we keep the files the model is working on re-read
 * fresh from disk each turn, at the END of the context (the boundary — best against
 * lost-in-the-middle). The model therefore always has the current content of what it's
 * editing and never needs to re-read it.
 *
 * The working CYCLE is the same for a 1-file task and a 50-file one: bounded ONLY by a
 * token budget, not an arbitrary file count. Within that budget the most-recent files
 * are shown in FULL; any that don't fit whole are LOCALIZED (outline + the regions the
 * model has focused on) rather than dropped — so a big task keeps every touched file's
 * structure, and full reads are reserved for what's actively being edited.
 *
 * The pure parts (selection, budgeting, rendering, line-numbering) are unit-tested;
 * `buildWorkingSet` does the disk/chassis I/O around them.
 */
import { promises as fs } from "node:fs";
import type { ReadRecord, ToolContext } from "../tools/types.js";
import type { FocusSpan } from "../tools/focus.js";
import type { OutlineEntry } from "../alternator/chassis/types.js";
import { chassisForPath } from "../tools/chassisMux.js";
import { relativize } from "../tools/paths.js";
import { estimateTokens } from "./compaction.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

/** Safety cap on how many touched files we even consider — NOT a "keep N" limit. The
 *  token budget + localization decide what actually fits; this only bounds work on a
 *  huge ledger so a long session doesn't stat hundreds of files each turn. */
export const WORKING_SET_MAX_CANDIDATES = env("MINDWEAVE_WORKINGSET_MAX_FILES", 40);
/** Total token budget for the working-set block — the ONLY real limit on how many
 *  files it holds (large ones are localized to fit, not dropped). */
export const WORKING_SET_TOKENS = env("MINDWEAVE_WORKINGSET_TOKENS", 20_000);
/** Above this many tokens, a single file is localized (outline + focus) not shown whole. */
const PER_FILE_MAX_TOKENS = env("MINDWEAVE_WORKINGSET_FILE_TOKENS", 6_000);

export interface PreparedFile {
  path: string; // absolute (ledger key)
  block: string; // the rendered block for this file
  tokens: number;
  full: boolean; // true when the WHOLE current file is included (drives read short-circuit)
}

/** The most-recently-touched files, most-recent first, capped at `max`. Pure. */
export function selectActiveFiles(reads: Map<string, ReadRecord>, max: number): { path: string; record: ReadRecord }[] {
  return [...reads.entries()]
    .map(([path, record]) => ({ path, record }))
    .sort((a, b) => (b.record.touchedAt ?? 0) - (a.record.touchedAt ?? 0))
    .slice(0, max);
}

/** Line-numbered slice of `lines` for [from..to] (1-based, clamped). Pure. */
export function numberedRange(lines: string[], from: number, to: number): string {
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${String(i).padStart(width)}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

/**
 * Assemble the `<working_files>` block from prepared per-file blocks (most-recent
 * first) within a token budget; least-recent overflow is dropped with a note. Returns
 * the text and the set of paths whose FULL content is included. Pure.
 */
export function renderWorkingFiles(prepared: PreparedFile[], budget: number): { text: string; fullPaths: Set<string> } {
  const kept: PreparedFile[] = [];
  let used = 0;
  for (const f of prepared) {
    if (kept.length > 0 && used + f.tokens > budget) break;
    kept.push(f);
    used += f.tokens;
  }
  if (kept.length === 0) return { text: "", fullPaths: new Set() };

  const header =
    "These are the CURRENT contents of the files you're working on, kept up to date " +
    "automatically. Edit straight from them — do NOT re-read a file shown here.";
  const body = kept.map((f) => f.block).join("\n\n");
  const evicted = prepared.length - kept.length;
  const note =
    evicted > 0
      ? `\n\n(${evicted} less-recent file${evicted === 1 ? "" : "s"} omitted to stay within budget — read on demand if needed)`
      : "";
  return { text: `${header}\n\n${body}${note}`, fullPaths: new Set(kept.filter((f) => f.full).map((f) => f.path)) };
}

/**
 * Build this turn's working-set block: read the current content of the active files
 * fresh from disk, keeping the freshest stat on the ledger (so read_file's
 * short-circuit compares correctly), localizing any file too big for its share.
 */
export async function buildWorkingSet(ctx: ToolContext): Promise<{ text: string; fullPaths: Set<string> }> {
  const active = selectActiveFiles(ctx.reads, WORKING_SET_MAX_CANDIDATES);
  const prepared: PreparedFile[] = [];
  let used = 0;

  for (const { path, record } of active) {
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      continue; // file gone since it was touched — skip
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch {
      continue;
    }
    if (looksBinary(content)) continue;

    // Keep the ledger's stat current so a later read of this file is recognized as
    // unchanged (the read short-circuit relies on matching mtime/size).
    ctx.reads.set(path, { ...record, mtimeMs: stat.mtimeMs, size: stat.size });

    const lines = content.split(/\r?\n/);
    const display = relativize(ctx, path);
    const fullBlock = `### ${display} (${lines.length} line${lines.length === 1 ? "" : "s"})\n${numberedRange(lines, 1, lines.length)}`;
    const fullTokens = estimateTokens(fullBlock);
    const firstFile = prepared.length === 0;

    // Show the file's FULL content when it's small enough for its own share AND fits
    // what's left of the budget (the most-recent file always gets in). Otherwise fall
    // back to a LOCALIZED block (outline + focused regions) rather than dropping it —
    // this is what makes the cycle identical for small and large tasks.
    if (fullTokens <= PER_FILE_MAX_TOKENS && (firstFile || used + fullTokens <= WORKING_SET_TOKENS)) {
      prepared.push({ path, block: fullBlock, tokens: fullTokens, full: true });
      used += fullTokens;
      continue;
    }

    const localBlock = await localizeBig(ctx, path, display, lines, record.focus);
    const localTokens = estimateTokens(localBlock);
    if (firstFile || used + localTokens <= WORKING_SET_TOKENS) {
      prepared.push({ path, block: localBlock, tokens: localTokens, full: false });
      used += localTokens;
    }
    // else: no room even for the localized form — a lower-priority file; skip it.
  }

  return renderWorkingFiles(prepared, WORKING_SET_TOKENS);
}

/** A large file's block: its outline + the regions the model has focused on. */
async function localizeBig(
  ctx: ToolContext,
  path: string,
  display: string,
  lines: string[],
  focus: FocusSpan[] | undefined,
): Promise<string> {
  const parts = [
    `### ${display} (${lines.length} lines — large; showing structure + your focused regions. ` +
      "Use read_symbol or a read_file range for anything else.)",
  ];
  const chassis = chassisForPath(ctx, path);
  if (chassis) {
    try {
      const outline = await chassis.outline(path);
      if (outline.length) parts.push("outline:\n" + renderOutline(outline));
    } catch {
      /* no outline — fine */
    }
  }
  for (const s of focus ?? []) {
    const from = Math.max(1, s.start - 2);
    const to = Math.min(lines.length, s.end + 2);
    parts.push(`lines ${from}-${to}:\n${numberedRange(lines, from, to)}`);
  }
  return parts.join("\n\n");
}

function renderOutline(entries: readonly OutlineEntry[], depth = 0): string {
  const out: string[] = [];
  for (const e of entries) {
    out.push(`${"  ".repeat(depth)}${e.kind} ${e.name} (L${e.line})`);
    if (e.children?.length) out.push(renderOutline(e.children, depth + 1));
  }
  return out.join("\n");
}

/** A NUL byte in the first chunk is a cheap "not text" signal. */
function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 8192);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
  return false;
}
