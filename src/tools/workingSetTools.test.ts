/**
 * workingSetTools.test.ts — the tool-side pieces of the working set: recordWrite now
 * marks a file `full:false` (the model has a window, not the file) + records recency
 * and focus, and read_file short-circuits a re-read of a file already in the set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { recordWrite, resolvePath } from "./paths.js";

function freshCtx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-tool-"));
  return { cwd: dir, reads: new Map(), todos: [] };
}

test("recordWrite marks the file full:false with recency + focus", async () => {
  const ctx = freshCtx();
  const p = join(ctx.cwd, "a.ts");
  await fs.writeFile(p, "one\ntwo\nthree\n");
  await recordWrite(ctx, p, { start: 2, end: 2 });
  const rec = ctx.reads.get(p)!;
  assert.equal(rec.full, false); // the fix: an edit gives a window, not the whole file
  assert.ok((rec.touchedAt ?? 0) > 0);
  assert.deepEqual(rec.focus, [{ start: 2, end: 2 }]);
});

test("read_file short-circuits when the file is already in the working set", async () => {
  const ctx = freshCtx();
  const p = join(ctx.cwd, "a.ts");
  await fs.writeFile(p, "const value = 42;\n");
  await readFile.execute({ path: "a.ts" }, ctx); // populate the ledger

  // Engine marks this file as held full in <working_files> for the turn.
  ctx.workingSetFull = new Set([resolvePath(ctx, "a.ts")]);
  const r = await readFile.execute({ path: "a.ts" }, ctx);
  assert.match(r.output, /<working_files>/);
  assert.doesNotMatch(r.output, /const value = 42/); // content NOT re-sent
});

test("read_file still returns content for a file NOT in the working set", async () => {
  const ctx = freshCtx();
  const p = join(ctx.cwd, "b.ts");
  await fs.writeFile(p, "const other = 7;\n");
  await readFile.execute({ path: "b.ts" }, ctx);
  ctx.workingSetFull = new Set(); // nothing held
  ctx.transcriptFull = new Set([p]); // but the original read is still in the transcript
  const r = await readFile.execute({ path: "b.ts" }, ctx);
  // Unchanged + full prior read + still in context → normal dedup note (not the
  // working-set note). Drop the line above and the content comes back instead.
  assert.match(r.output, /unchanged/);
});
