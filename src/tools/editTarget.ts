/**
 * editTarget.ts — the shared pre-edit gauntlet for edit_file and multi_edit.
 *
 * Both tools must clear the exact same gates before touching a file: path guards
 * (protected + forbidden-with-lift), the file must exist and be a file, and it
 * must have been READ this session (the anti-confabulation rule). Factoring it
 * here keeps that policy in one place so the two tools can never drift apart on
 * safety. Returns the file's content + detected EOL on success, or a ready-made
 * failure ToolResult to hand straight back.
 */
import { promises as fs } from "node:fs";
import type { ToolContext, ToolResult } from "./types.js";
import { protectedPathReason } from "./guard.js";
import { forbiddenPathReason } from "../governor/forbidden.js";
import { requestForbiddenLift } from "./approval.js";
import { resolvePath } from "./paths.js";
import { detectEol } from "./eol.js";

export interface EditTarget {
  ok: true;
  /** Absolute resolved path. */
  filePath: string;
  /** Current file contents (raw, with its real line endings). */
  content: string;
  /** The file's detected EOL, to preserve on write. */
  eol: ReturnType<typeof detectEol>;
}

export type PrepareResult = EditTarget | { ok: false; error: ToolResult };

/** Run the shared pre-edit checks for `rawPath`. `verb` names the action in
 *  messages (e.g. "editing"). */
export async function prepareEditTarget(
  ctx: ToolContext,
  rawPath: string,
  verb: string,
): Promise<PrepareResult> {
  const filePath = resolvePath(ctx, rawPath);

  const blocked = protectedPathReason(filePath);
  if (blocked) return { ok: false, error: fail(`Refusing to edit ${rawPath}: it is ${blocked}.`) };

  const forbidden = forbiddenPathReason(ctx.governance?.forbidden, filePath);
  if (forbidden) {
    const lift = await requestForbiddenLift(
      ctx,
      forbidden,
      `${verb} ${rawPath}`,
      `the user has forbidden touching '${forbidden}'.`,
    );
    if (lift) return { ok: false, error: lift }; // refused/deferred; an allow returns null → falls through
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, error: fail(`file ${rawPath} not found. Use write_file to create a new file.`) };
  }
  if (stat.isDirectory()) return { ok: false, error: fail(`${rawPath} is a directory, not a file.`) };

  // Read-before-edit: the anti-confabulation gate.
  if (!ctx.reads.has(filePath)) {
    return {
      ok: false,
      error: fail(
        `${rawPath} has not been read this session. Read it first so your edit matches the real content.`,
      ),
    };
  }

  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: fail(`could not read ${rawPath}: ${errText(error)}`) };
  }

  return { ok: true, filePath, content, eol: detectEol(content) };
}

export function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
