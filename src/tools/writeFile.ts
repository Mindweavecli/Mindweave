/**
 * writeFile.ts — create a file, or fully replace one the model has read.
 *
 * The mutating partner of read_file. The tool's whole job is to put bytes on
 * disk safely; *what* to write is the model's job, so there are no rules here
 * about "good content".
 *
 * Guards (all mechanical):
 *  - Protected paths (.env, keys, .git) are refused outright — see guard.ts.
 *  - Blind overwrite is refused: if the file already exists, it must have been
 *    read this session first. This is the same read-before-touch contract every
 *    serious agent enforces — it stops the model from clobbering a file it never
 *    looked at. Brand-new files write freely.
 *  - Parent directories are created as needed.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { foreignAgentReason, protectedPathReason } from "./guard.js";
import { forbiddenPathReason } from "../governor/forbidden.js";
import { requestAgentDataAccess, requestForbiddenLift } from "./approval.js";
import { recordWrite, relativize, resolvePath } from "./paths.js";
import { writeDetail, withScope } from "./detail.js";
import { applyEol, dirEol, fileEol } from "./eol.js";

export const writeFile: Tool = {
  name: "write_file",
  readOnly: false,
  description:
    "Create a new file, or replace an existing one wholesale. To overwrite an existing file " +
    "you must read_file it first. Prefer a targeted change to rewriting: use edit_file to " +
    "change one place in a file, multi_edit for several places in the same file, and this " +
    "only when the file is new or genuinely being replaced end to end. Rewriting a file to " +
    "change part of it risks dropping code you didn't mean to touch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file, absolute or relative to the working directory.",
      },
      content: {
        type: "string",
        description: "The full contents to write. Use an empty string for an empty file.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return fail("`path` is required.");
    if (typeof args.content !== "string") {
      return fail("`content` is required (use an empty string for an empty file).");
    }
    const content = args.content;

    const filePath = resolvePath(ctx, rawPath);
    const blocked = protectedPathReason(filePath);
    if (blocked) {
      return fail(`Refusing to write ${rawPath}: it is ${blocked}.`);
    }
    // Another tool's data — ask before writing into a history we weren't part of.
    const otherTool = foreignAgentReason(filePath);
    if (otherTool) {
      const denied = await requestAgentDataAccess(ctx, otherTool, `Writing ${rawPath}`);
      if (denied) return denied;
    }
    const forbidden = forbiddenPathReason(ctx.governance?.forbidden, filePath);
    if (forbidden) {
      const lift = await requestForbiddenLift(
        ctx,
        forbidden,
        `writing ${rawPath}`,
        `the user has forbidden touching '${forbidden}'.`,
      );
      if (lift) return lift; // refused or deferred; an allow lifts it and falls through
    }

    let existed = false;
    try {
      const stat = await fs.stat(filePath);
      existed = true;
      if (stat.isDirectory()) {
        return fail(`${rawPath} is a directory, not a file.`);
      }
    } catch {
      existed = false;
    }

    // Read-before-overwrite: refuse to blindly replace a file the model hasn't seen.
    if (existed && !ctx.reads.has(filePath)) {
      return fail(
        `${rawPath} already exists and hasn't been read this session. Read it ` +
          `first if you really mean to replace it, or use edit_file to change part of it.`,
      );
    }

    // Respect line-ending style: keep an existing file's endings, or match a
    // sibling for a new file (the model only ever emits LF). Avoids turning a
    // CRLF project into a mix of CRLF and LF files.
    const eol = existed ? await fileEol(filePath) : await dirEol(dirname(filePath));

    // The exact bytes about to land on disk — checkpointing needs the same value we
    // write, not the pre-EOL content, or /undo would read a mismatch and call it a
    // conflict on a file nobody else touched.
    const outgoing = applyEol(content, eol);

    // Snapshot for /undo: the file's current bytes if it existed, else null so undo
    // deletes what this write creates.
    if (ctx.checkpoints) {
      let original: string | null = null;
      if (existed) {
        try {
          original = await fs.readFile(filePath, "utf8");
        } catch {
          original = null;
        }
      }
      ctx.checkpoints.backup(filePath, original, outgoing);
    }

    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, outgoing, "utf8");
    } catch (error) {
      return fail(`could not write ${rawPath}: ${errText(error)}`);
    }

    // Now seen+written — record the new state so it stays edit-eligible and a
    // follow-up read of it deduplicates instead of re-sending what we just wrote.
    await recordWrite(ctx, filePath);

    const shown = relativize(ctx, filePath);
    const lines = content === "" ? 0 : content.split("\n").length;
    const plural = lines === 1 ? "" : "s";
    // Be explicit about scope: overwriting replaces the ENTIRE file (the user asked to
    // be able to tell "did it rewrite the whole thing or just part?"), vs. a fresh file.
    const scope = existed ? `whole file · ${lines} line${plural}` : `new file · ${lines} line${plural}`;
    return {
      output: existed
        ? `Rewrote all of ${shown} (${lines} line${plural}).`
        : `Created ${shown} (${lines} line${plural}).`,
      summary: existed ? `rewrote all of ${shown} · ${lines} line${plural}` : `created ${shown} · ${lines} line${plural}`,
      detail: withScope(scope, writeDetail(content)),
    };
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
