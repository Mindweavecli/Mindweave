import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { multiEdit } from "./multiEdit.js";

function freshCtx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-test-"));
  return { cwd: dir, reads: new Map(), todos: [] };
}

test("multi_edit applies several edits to one file in order", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta gamma");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await multiEdit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "alpha", new_string: "ONE" },
        { old_string: "beta", new_string: "TWO" },
        { old_string: "gamma", new_string: "THREE" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "ONE TWO THREE");
  assert.match(r.output, /3 edits, 3 replacements/);
});

test("multi_edit lets a later edit target text an earlier edit produced", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "hello world");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await multiEdit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "hello", new_string: "hi" },
        { old_string: "hi world", new_string: "hi there" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "hi there");
});

test("multi_edit is atomic: one bad edit writes nothing", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await multiEdit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "does-not-exist", new_string: "x" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /edit #2/);
  // The file is untouched — the first edit did NOT land.
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "alpha beta");
});

test("multi_edit refuses a file that wasn't read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  const r = await multiEdit.execute(
    { path: "c.txt", edits: [{ old_string: "alpha", new_string: "A" }] },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /has not been read/);
});

test("multi_edit preserves CRLF line endings", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "a\r\nb\r\nc");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await multiEdit.execute(
    { path: "c.txt", edits: [{ old_string: "a\nb", new_string: "A\nB" }] },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "A\r\nB\r\nc");
});

test("multi_edit rejects an empty edits array", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await multiEdit.execute({ path: "c.txt", edits: [] }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /non-empty array/);
});
