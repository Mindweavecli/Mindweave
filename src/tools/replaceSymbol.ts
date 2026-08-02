/**
 * replaceSymbol.ts — replace one symbol's whole definition, by name.
 *
 * The surgical, structural edit: instead of matching an exact old_string, the model
 * names a symbol and supplies its complete new definition; the tool finds that
 * symbol's line span (LSP `documentSymbol` range, tree-sitter fallback) and swaps
 * those lines. It's the natural pair to read_symbol — read a function, rewrite it —
 * and avoids brittle whitespace-exact matching for a full-body rewrite.
 *
 * Safety is identical to edit_file's, and then some: it reuses the shared pre-edit
 * gauntlet (path guards, forbidden-lift, read-before-edit), snapshots for /undo, and
 * REFUSES an ambiguous target — if the name resolves to more than one symbol it
 * writes nothing and asks for a `path`, so a rewrite can never land on the wrong one.
 * Deciding WHAT the new definition should be is the model's job; this only applies it.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "./types.js";
import { recordWrite, relativize, resolvePath } from "./paths.js";
import { applyEol } from "./eol.js";
import { editDetail, lineCount, magnitude, withScope } from "./detail.js";
import { numberedWindow } from "./editFile.js";
import { normalizeLf } from "./editCore.js";
import { prepareEditTarget, fail, errText } from "./editTarget.js";
import { allChassis, symbolSpans } from "./chassisMux.js";
import { rawLines, spliceLines } from "./spanCore.js";

export const replaceSymbolBody: Tool = {
  name: "replace_symbol_body",
  readOnly: false,
  description:
    "Replace a whole symbol (function, class, method, type, …) with a new definition, by name. " +
    "Give the symbol `name` and the complete `new_definition` (its signature AND body). The tool " +
    "locates the symbol via the code map and swaps its lines — no exact old_string needed. Read the " +
    "symbol first (read_symbol). Pass `path` when the name is defined in more than one file; if the " +
    "target is ambiguous the tool changes nothing and asks you to narrow it. Prefer this when you are " +
    "rewriting a whole function or class; use edit_file or multi_edit for changes WITHIN one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "new_definition"],
    properties: {
      name: { type: "string", description: "The symbol to replace." },
      new_definition: {
        type: "string",
        description: "The complete replacement definition — signature and body, as it should appear in the file.",
      },
      path: {
        type: "string",
        description: "File the symbol is in (optional; disambiguates a name defined in several files).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return fail("`name` is required.");
    if (typeof args.new_definition !== "string" || args.new_definition.trim() === "") {
      return fail("`new_definition` is required and must not be empty (use edit_file to delete a symbol).");
    }
    if (allChassis(ctx).length === 0) {
      return fail("the code map isn't available here — use edit_file with an exact old_string instead.");
    }

    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const wantAbs = rawPath ? resolvePath(ctx, rawPath) : undefined;
    const spans = await symbolSpans(ctx, name, wantAbs ? { path: wantAbs } : {});

    if (spans.length === 0) {
      return fail(
        `couldn't locate a symbol named '${name}'${rawPath ? ` in ${rawPath}` : ""}. ` +
          "Read it first (read_symbol / outline), or use edit_file with an exact old_string.",
      );
    }
    // Ambiguous → refuse and list. Never guess which definition to overwrite.
    if (spans.length > 1) {
      const list = spans.map((s) => `${relativize(ctx, s.file)}:${s.start}-${s.end}`).join(", ");
      const hint = new Set(spans.map((s) => s.file)).size > 1 ? "pass `path` to pick one" : "the name is defined more than once here";
      return fail(`'${name}' is ambiguous (${list}) — ${hint}. No changes were written.`);
    }

    const span = spans[0]!;
    const abs = resolvePath(ctx, span.file);
    const target = await prepareEditTarget(ctx, abs, "editing");
    if (!target.ok) return target.error;
    const { filePath, content, eol } = target;

    const before = normalizeLf(content);
    const oldBody = rawLines(before, span.start, span.end);
    const updatedNorm = spliceLines(before, span.start, span.end, args.new_definition);
    if (updatedNorm === before) {
      return fail(`\`new_definition\` matches the current definition of '${name}' — nothing to change.`);
    }
    const updated = applyEol(updatedNorm, eol);

    // Snapshot the pre-edit bytes for /undo before touching disk.
    ctx.checkpoints?.backup(filePath, content);
    try {
      await fs.writeFile(filePath, updated, "utf8");
    } catch (error) {
      return fail(`could not write ${relativize(ctx, filePath)}: ${errText(error)}`);
    }
    await recordWrite(ctx, filePath, {
      start: span.start,
      end: span.start + normalizeLf(args.new_definition).split("\n").length - 1,
    });

    const shown = relativize(ctx, filePath);
    // Show the new definition WITH fresh line numbers, so the model can keep editing
    // from the result rather than re-reading the file.
    const newStart = charAtLine(updatedNorm, span.start); // start char of the replaced region
    const newLineCount = normalizeLf(args.new_definition).split("\n").length;
    const window = numberedWindow(updatedNorm, newStart, newStart + args.new_definition.length);
    // Scope: which symbol, the span it used to occupy, and the ± lines — so a whole-
    // symbol rewrite reads as "reserveBook · was L120-138 · −18 +24", not a bare diff.
    const removed = lineCount(oldBody);
    const scope = `${span.name} · was L${span.start}-${span.end} · ${magnitude(removed, newLineCount)}`;
    return {
      output:
        `Replaced ${span.kind} ${span.name} in ${shown} ` +
        `(was lines ${span.start}-${span.end}, now ${newLineCount} line${newLineCount === 1 ? "" : "s"}).\n` +
        `New definition — line-numbered so you can make further edits without re-reading:\n${window}`,
      summary: `replaced ${span.name} in ${shown} · ${scope}`,
      detail: withScope(scope, editDetail(oldBody, args.new_definition)),
    };
  },
};

/** The char offset of the first character of 1-based `line` in LF text. */
function charAtLine(text: string, line: number): number {
  let offset = 0;
  let current = 1;
  while (current < line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    current++;
  }
  return offset;
}
