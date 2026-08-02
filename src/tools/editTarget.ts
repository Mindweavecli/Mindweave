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
import { foreignAgentReason, protectedPathReason } from "./guard.js";
import { forbiddenPathReason } from "../governor/forbidden.js";
import { requestAgentDataAccess, requestForbiddenLift } from "./approval.js";
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

  // Another tool's data. Writing to it is worse than reading it — we'd be editing
  // a history we were never part of — so it goes through the same ask-first gate.
  const otherTool = foreignAgentReason(filePath);
  if (otherTool) {
    const denied = await requestAgentDataAccess(ctx, otherTool, `${verb} ${rawPath}`);
    if (denied) return { ok: false, error: denied };
  }

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
  const seen = ctx.reads.get(filePath);
  if (!seen) {
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

  // Freshness: has the file moved since it was read?
  //
  // Without this the situation is still SAFE — the edit is matched against the file's
  // current bytes, so a stale `old_string` simply fails to match — but it is diagnosed
  // WRONGLY. The model is told "old_string not found, re-read and copy the target text
  // precisely", which reads as "you mistyped", so it retries the same doomed string
  // instead of re-reading. The cause has to be named for the recovery to be the right one.
  //
  // And the quieter case is worse: if the change landed somewhere the model is not
  // editing, its edit applies cleanly against content nobody has looked at. That is the
  // only path here where a confident edit is made on stale understanding, so it is worth
  // one comparison of two numbers we already hold.
  if (changedSinceRead(seen, stat)) {
    return {
      ok: false,
      error: failQuietly(
        `${rawPath} changed on disk since you read it (a command, a formatter, or the user). ` +
          `Your view of this file is out of date, so an edit based on it could be wrong even where it matches. ` +
          `Read it again, then redo the edit against what it says now.`,
      ),
    };
  }

  return { ok: true, filePath, content, eol: detectEol(content) };
}

/**
 * Did the file change between the read that put it in the ledger and now (pure)?
 *
 * Both signals are checked because either alone misses real cases: mtime resolution is
 * coarse enough on some filesystems that a fast rewrite keeps the same stamp, and a size
 * comparison alone misses any edit that happens to preserve length — a renamed symbol, a
 * flipped boolean, a changed constant. Neither is exotic in a codebase.
 *
 * A file the ledger has no size for (an older record, or one seeded rather than read) is
 * treated as unchanged: refusing on missing bookkeeping would block edits over our own
 * gap rather than over anything the user did.
 */
export function changedSinceRead(
  seen: { mtimeMs?: number; size?: number },
  now: { mtimeMs: number; size: number },
): boolean {
  if (typeof seen.size === "number" && seen.size !== now.size) return true;
  if (typeof seen.mtimeMs === "number" && seen.mtimeMs > 0 && Math.abs(seen.mtimeMs - now.mtimeMs) > 1) return true;
  return false;
}

export function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

/**
 * A failure the model is expected to fix by itself, this turn.
 *
 * Identical to `fail` for the model — same error text, same `isError`, so nothing about
 * its recovery changes — but marked `quiet` so the UI does not paint a red row for what
 * is really a mid-thought correction. See `ToolResult.quiet` for where the line sits.
 */
export function failQuietly(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message, quiet: true };
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
