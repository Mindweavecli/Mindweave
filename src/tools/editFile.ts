/**
 * editFile.ts — a surgical find-and-replace on one file.
 *
 * The workhorse mutating tool. It replaces an exact `old_string` with
 * `new_string`. Reliability comes from the tool REFUSING bad edits, not from the
 * model being careful — the three refusals below make the classic failure modes
 * (editing a file you never read, a stale/typo'd match, an ambiguous match)
 * structurally impossible:
 *
 *  - read-before-edit: the file must have been read this session, so the model's
 *    `old_string` is copied from real content, not imagined.
 *  - must-exist: zero matches errors instead of silently doing nothing, so the
 *    model learns its match was wrong.
 *  - unique-match: more than one match (without replace_all) errors and hands back
 *    WHERE the candidates are, so an edit never lands in the wrong place and the
 *    retry is informed rather than another guess.
 *
 * Matching is exact first, then line-trimmed — and stops there. It is deliberately not
 * a stack of ever-looser matchers: past a point, "looser" only means "more ways to edit
 * the wrong block", which is a corruption bug rather than a convenience. The reasoning,
 * and what is deliberately NOT implemented, lives in editCore.ts.
 * (Deciding *what* to change is the model's job; this tool only applies it.)
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "./types.js";
import { recordWrite, relativize } from "./paths.js";
import { editDetail, lineCount, magnitude, rangeLabel, withScope } from "./detail.js";
import { applyEol } from "./eol.js";
import { applyOneEdit } from "./editCore.js";
import { prepareEditTarget, fail, failQuietly, errText } from "./editTarget.js";

export const editFile: Tool = {
  name: "edit_file",
  readOnly: false,
  description:
    "Replace a string in a file with another. This is the DEFAULT editing tool: reach for " +
    "it whenever you are changing one place in a file. `old_string` must match the file's " +
    "text and be unique unless `replace_all` is set — include surrounding lines if it isn't. " +
    "Read the file first. If the SAME file needs changing in several separate places, use " +
    "multi_edit instead of calling this repeatedly. Use write_file only to create a new file " +
    "or replace one wholesale.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "old_string", "new_string"],
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file, absolute or relative to the working directory.",
      },
      old_string: {
        type: "string",
        description:
          "The exact text to replace. Include enough surrounding lines to make it unique.",
      },
      new_string: {
        type: "string",
        description: "The replacement text. Use an empty string to delete old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match. Default false.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return fail("`path` is required.");
    if (typeof args.old_string !== "string" || args.old_string === "") {
      return fail("`old_string` is required and must not be empty — it identifies the text to replace.");
    }
    if (typeof args.new_string !== "string") {
      return fail("`new_string` is required (use an empty string to delete old_string).");
    }
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = args.replace_all === true;

    if (oldString === newString) {
      return fail("`old_string` and `new_string` are identical — nothing to change.");
    }

    const target = await prepareEditTarget(ctx, rawPath, "editing");
    if (!target.ok) return target.error;
    const { filePath, content, eol } = target;

    // Match line-ending-agnostically. The file on disk may use CRLF (Windows)
    // while the model's old_string — copied from text it was shown — uses LF; an
    // exact byte match would then fail on every multi-line edit. Normalizing the
    // CR the model can't see is a representation fix, not fuzzy matching: we still
    // match whitespace and indentation exactly (handled in editCore). The file's
    // own line endings are preserved on write.
    const applied = applyOneEdit(content, { oldString, newString, replaceAll });
    // A match that didn't land is the model's to correct — it gets the reason and the
    // candidate locations, and retries. Not the user's business, so it stays off screen.
    if (!applied.ok) return failQuietly(`${applied.reason} (in ${rawPath}).`);
    const { updated: updatedNorm, count, changeStart, changeEnd } = applied;
    const updated = applyEol(updatedNorm, eol);

    // Snapshot the pre-edit bytes for /undo before touching disk.
    ctx.checkpoints?.backup(filePath, content, updated);
    try {
      await fs.writeFile(filePath, updated, "utf8");
    } catch (error) {
      return fail(`could not write ${rawPath}: ${errText(error)}`);
    }

    // Still seen+touched this session — record the new state (with the edited region
    // as this file's focus, so a large file localizes to it in the working set).
    await recordWrite(ctx, filePath, {
      start: charToLine(updatedNorm, Math.max(0, changeStart)) + 1,
      end: charToLine(updatedNorm, changeEnd) + 1,
    });

    const shown = relativize(ctx, filePath);
    const n = replaceAll ? count : 1;
    const plural = n === 1 ? "" : "s";
    // Hand back the changed region WITH fresh line numbers. This is what stops the
    // model from re-reading the whole file after every edit (the loop that bloats a
    // multi-edit task): it can target its next edit straight from this snippet.
    const window = numberedWindow(updatedNorm, Math.max(0, changeStart), changeEnd);
    const span = replaceAll && n > 1 ? ` (showing the first of ${n} sites)` : "";
    // The scope of the change — WHERE and HOW MUCH — so the row shows more than a bare
    // diff: the line range touched (or "N sites" for a spread replace_all) and ± lines.
    const startLine = charToLine(updatedNorm, Math.max(0, changeStart)) + 1;
    const endLine = charToLine(updatedNorm, changeEnd) + 1;
    const removed = lineCount(oldString) * n;
    const added = lineCount(newString) * n;
    const scope =
      replaceAll && n > 1
        ? `${n} sites · ${magnitude(removed, added)}`
        : `${rangeLabel(startLine, endLine)} · ${magnitude(removed, added)}`;
    return {
      output:
        `Edited ${shown}: ${n} replacement${plural}.\n` +
        `Updated region${span} — line-numbered so you can make further edits without re-reading:\n${window}`,
      summary: `edited ${shown} · ${scope}`,
      detail: withScope(scope, editDetail(oldString, newString)),
    };
  },
};

/**
 * Render the lines spanning [startChar, endChar] in `text`, plus `pad` lines of
 * context on each side, with 1-based right-aligned line numbers. Pure and indexed
 * on the normalized (LF) text, so it's independent of the file's real EOL. Bounded
 * by `maxLines` so a sweeping replace can't flood the result.
 */
export function numberedWindow(
  text: string,
  startChar: number,
  endChar: number,
  pad = 4,
  maxLines = 30,
): string {
  const lines = text.split("\n");
  const startLine = charToLine(text, startChar);
  const endLine = charToLine(text, endChar);
  const from = Math.max(0, startLine - pad);
  let to = Math.min(lines.length - 1, endLine + pad);
  let truncated = false;
  if (to - from + 1 > maxLines) {
    to = from + maxLines - 1;
    truncated = true;
  }
  const width = String(to + 1).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${String(i + 1).padStart(width)}  ${lines[i] ?? ""}`);
  }
  if (truncated) out.push("    … (region continues; re-read the file if you need the rest)");
  return out.join("\n");
}

/** The 0-based line a character offset falls on (count of newlines before it). */
export function charToLine(text: string, charIndex: number): number {
  let line = 0;
  const limit = Math.min(charIndex, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}
