/**
 * checkpoints.ts — a per-turn undo net for file edits.
 *
 * Recoverability without git: whenever a mutating tool is about to change a file,
 * it first hands the file's ORIGINAL bytes here (once per file per turn — the
 * first touch wins, so we keep the true pre-turn state). At the end of a turn the
 * engine `seal`s those originals into one restorable checkpoint. `/undo` then
 * rolls the last turn's file changes back — restoring edited files to their prior
 * contents and deleting files the turn created.
 *
 * It's deliberately a shadow-copy in memory (bounded stack), not a shadow git
 * repo: cheap, dependency-free, and it works even when the project isn't a git
 * repo at all. Client-side state (holds file bytes), like the background shells —
 * absent in bare contexts, in which case edits simply aren't checkpointed.
 */
import { promises as fs } from "node:fs";

/** One sealed checkpoint: the files a single turn changed, and their pre-turn state
 *  (`null` original = the file did not exist before the turn → undo deletes it). */
export interface Checkpoint {
  label: string;
  at: number;
  files: Map<string, string | null>;
}

export interface UndoResult {
  label: string;
  at: number;
  restored: string[];
}

export class Checkpoints {
  private current = new Map<string, string | null>();
  private stack: Checkpoint[] = [];
  constructor(private readonly max = 20) {}

  /** Record a file's pre-change content the first time it's touched this turn.
   *  `original` is the exact bytes on disk (or null for a not-yet-existing file). */
  backup(absPath: string, original: string | null): void {
    if (!this.current.has(absPath)) this.current.set(absPath, original);
  }

  /** Close this turn's edits into a restorable checkpoint. No-op if nothing changed. */
  seal(label: string): void {
    if (this.current.size === 0) return;
    this.stack.push({ label: label || "(edits)", at: Date.now(), files: this.current });
    this.current = new Map();
    while (this.stack.length > this.max) this.stack.shift();
  }

  /** Whether there's a sealed checkpoint to undo. */
  hasUndo(): boolean {
    return this.stack.length > 0;
  }

  /** The label of the checkpoint that `undo()` would restore, if any. */
  nextUndoLabel(): string | undefined {
    return this.stack[this.stack.length - 1]?.label;
  }

  /**
   * Restore the most recent sealed checkpoint: rewrite edited files with their
   * original bytes and remove files the turn created. Best-effort per file (a
   * restore that throws is skipped, not fatal). Returns what was restored, or null
   * if there was nothing to undo.
   */
  async undo(): Promise<UndoResult | null> {
    const cp = this.stack.pop();
    if (!cp) return null;
    const restored: string[] = [];
    for (const [path, original] of cp.files) {
      try {
        if (original === null) await fs.rm(path, { force: true });
        else await fs.writeFile(path, original, "utf8");
        restored.push(path);
      } catch {
        // Leave it; report only what we actually rolled back.
      }
    }
    return { label: cp.label, at: cp.at, restored };
  }
}
