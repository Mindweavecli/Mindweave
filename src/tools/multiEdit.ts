/**
 * multiEdit.ts — several exact edits to ONE file in a single call, applied in
 * order and atomically.
 *
 * Why it exists: a real change to a file is often several small replacements. One
 * per turn (edit_file) burns model turns and step budget and re-invites the
 * re-read-after-every-edit loop. multi_edit lands them together — each edit sees
 * the result of the one before, so you can add a symbol and then edit around it.
 *
 * ATOMIC: the edits are applied to an in-memory copy; if ANY of them fails to
 * match (the same exact/must-exist/unique rules as edit_file), nothing is written
 * and the offending edit is named. A file is never left half-changed. It reuses
 * the shared pre-edit gauntlet (read-before-edit, path guards) and the pure edit
 * core, so its safety guarantees are identical to edit_file's.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "./types.js";
import { recordWrite, relativize } from "./paths.js";
import { applyEol } from "./eol.js";
import { multiEditDetail, lineCount, magnitude, rangeLabel, withScope } from "./detail.js";
import { applyEditSequence, type EditOp } from "./editCore.js";
import { numberedWindow, charToLine } from "./editFile.js";
import { prepareEditTarget, fail, errText } from "./editTarget.js";

export const multiEdit: Tool = {
  name: "multi_edit",
  readOnly: false,
  description:
    "Apply several exact string replacements to ONE file in a single call, in order. " +
    "Each edit's `old_string` must match the file verbatim and be unique unless " +
    "`replace_all` is set; each edit sees the result of the previous ones. All-or-nothing: " +
    "if any edit doesn't match, the file is left untouched. Read the file first. Prefer this " +
    "over multiple edit_file calls when changing a file in more than one place.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "edits"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory.",
      },
      edits: {
        type: "array",
        description: "The replacements to apply, in order.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["old_string", "new_string"],
          properties: {
            old_string: {
              type: "string",
              description: "The exact text to replace. Include enough surrounding lines to make it unique.",
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
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return fail("`path` is required.");
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return fail("`edits` is required and must be a non-empty array of {old_string, new_string} edits.");
    }

    // Validate and normalize each edit up front, so a bad shape is reported before
    // we touch the file.
    const ops: EditOp[] = [];
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i] as Record<string, unknown>;
      if (!e || typeof e !== "object") return fail(`edit #${i + 1} is not an object.`);
      if (typeof e.old_string !== "string" || e.old_string === "") {
        return fail(`edit #${i + 1}: \`old_string\` is required and must not be empty.`);
      }
      if (typeof e.new_string !== "string") {
        return fail(`edit #${i + 1}: \`new_string\` is required (use an empty string to delete).`);
      }
      ops.push({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all === true });
    }

    const target = await prepareEditTarget(ctx, rawPath, "editing");
    if (!target.ok) return target.error;
    const { filePath, content, eol } = target;

    // Apply the whole sequence to an in-memory copy. Atomic: a failure names the
    // offending edit and writes nothing.
    const seq = applyEditSequence(content, ops);
    if (!seq.ok) {
      return fail(`edit #${seq.index + 1} could not be applied to ${rawPath}: ${seq.reason}. No changes were written.`);
    }

    const updated = applyEol(seq.updated, eol);
    // Snapshot the pre-edit bytes for /undo before touching disk.
    ctx.checkpoints?.backup(filePath, content);
    try {
      await fs.writeFile(filePath, updated, "utf8");
    } catch (error) {
      return fail(`could not write ${rawPath}: ${errText(error)}`);
    }
    await recordWrite(ctx, filePath, {
      start: charToLine(seq.updated, seq.spanStart) + 1,
      end: charToLine(seq.updated, seq.spanEnd) + 1,
    });

    const shown = relativize(ctx, filePath);
    const nEdits = ops.length;
    // One numbered window spanning from the first change to the last, so the model
    // can keep working from the result without re-reading the file.
    const window = numberedWindow(seq.updated, seq.spanStart, seq.spanEnd);
    // Scope: how many edits, the line span they cover, and the ± lines across them —
    // so a multi-part change reads as "3 edits · L120-420 · −18 +40", not just a diff.
    const startLine = charToLine(seq.updated, seq.spanStart) + 1;
    const endLine = charToLine(seq.updated, seq.spanEnd) + 1;
    let removed = 0;
    let added = 0;
    for (const op of ops) {
      removed += lineCount(op.oldString);
      added += lineCount(op.newString);
    }
    const scope = `${nEdits} edits · ${rangeLabel(startLine, endLine)} · ${magnitude(removed, added)}`;
    return {
      output:
        `Edited ${shown}: ${nEdits} edits, ${seq.total} replacement${seq.total === 1 ? "" : "s"} total.\n` +
        `Changed region — line-numbered so you can make further edits without re-reading:\n${window}`,
      summary: `edited ${shown} · ${scope}`,
      detail: withScope(scope, multiEditDetail(ops)),
    };
  },
};
