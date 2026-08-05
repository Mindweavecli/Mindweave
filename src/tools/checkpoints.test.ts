/**
 * checkpoints.test.ts — the /undo net.
 *
 * The decision table (`undoAction`) is tested exhaustively because that is where the
 * two dangerous mistakes live: overwriting an edit somebody else made, and
 * mishandling a file that is no longer on disk. The class tests then cover the
 * lifecycle around it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints, parseUndoArg, undoAction, undoNotice, type UndoResult } from "./checkpoints.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mindweave-cp-"));
}

// ── the decision table ────────────────────────────────────────────────────────
test("an untouched edit is restored", () => {
  assert.equal(undoAction({ original: "v0", written: "v1" }, "v1"), "restore");
});

test("a file the turn created is deleted", () => {
  assert.equal(undoAction({ original: null, written: "new" }, "new"), "delete");
});

test("a file changed since we wrote it is a conflict, never an overwrite", () => {
  // The user (or their editor, or another process) has moved it on. Restoring "v0"
  // here would silently destroy work we did not do.
  assert.equal(undoAction({ original: "v0", written: "v1" }, "v1 plus their edit"), "conflict");
});

test("a file that vanished after we edited it is a conflict, not a resurrection", () => {
  // Deleting it was somebody's deliberate act; putting it back would undo that.
  assert.equal(undoAction({ original: "v0", written: "v1" }, null), "conflict");
});

test("a file the turn created and someone already deleted is settled", () => {
  // The end state undo wants is already true — say nothing, do nothing.
  assert.equal(undoAction({ original: null, written: "new" }, null), "settled");
});

// ── the lifecycle ─────────────────────────────────────────────────────────────
test("undo restores an edited file's original content", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "original");
  const cp = new Checkpoints();
  cp.backup(f, "original", "edited");
  await fs.writeFile(f, "edited");
  cp.seal("edit a");
  const r = await cp.undo();
  assert.ok(r);
  assert.deepEqual(r!.restored, [f]);
  assert.equal(await fs.readFile(f, "utf8"), "original");
  assert.equal(cp.hasUndo(), false, "a fully settled checkpoint retires");
});

test("undo deletes a file the turn created (original was null)", async () => {
  const dir = tmp();
  const f = join(dir, "new.txt");
  const cp = new Checkpoints();
  cp.backup(f, null, "brand new"); // didn't exist before
  await fs.writeFile(f, "brand new");
  cp.seal("create new");
  await cp.undo();
  assert.equal(await fs.stat(f).then(() => true, () => false), false, "file should be gone");
});

test("undo refuses to clobber a file edited after the turn", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "original");
  const cp = new Checkpoints();
  cp.backup(f, "original", "agent edit");
  await fs.writeFile(f, "agent edit");
  cp.seal("edit a");

  await fs.writeFile(f, "the user's own work"); // they changed it afterwards

  const r = await cp.undo();
  assert.deepEqual(r!.conflicts, [f]);
  assert.deepEqual(r!.restored, []);
  assert.equal(await fs.readFile(f, "utf8"), "the user's own work", "their edit must survive");
});

test("first touch wins for the original, last write wins for what's on disk", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "v0");
  const cp = new Checkpoints();
  cp.backup(f, "v0", "v1");
  await fs.writeFile(f, "v1");
  cp.backup(f, "v1", "v2"); // second touch — keeps v0 as the original, expects v2 on disk
  await fs.writeFile(f, "v2");
  cp.seal("two edits");
  const r = await cp.undo();
  assert.deepEqual(r!.conflicts, [], "v2 is what we wrote, so this is not a conflict");
  assert.equal(await fs.readFile(f, "utf8"), "v0");
});

test("seal is a no-op when nothing was backed up", async () => {
  const cp = new Checkpoints();
  cp.seal("empty turn");
  assert.equal(cp.hasUndo(), false);
  assert.equal(await cp.undo(), null);
});

test("undo pops one checkpoint at a time (LIFO)", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "base");
  const cp = new Checkpoints();

  cp.backup(f, "base", "turn1");
  await fs.writeFile(f, "turn1");
  cp.seal("turn 1");

  cp.backup(f, "turn1", "turn2");
  await fs.writeFile(f, "turn2");
  cp.seal("turn 2");

  assert.equal(cp.nextUndoLabel(), "turn 2");
  await cp.undo();
  assert.equal(await fs.readFile(f, "utf8"), "turn1");
  await cp.undo();
  assert.equal(await fs.readFile(f, "utf8"), "base");
  assert.equal(cp.hasUndo(), false);
});

test("a turn that ran a shell is flagged, so /undo can say what it did not cover", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "original");
  const cp = new Checkpoints();
  cp.backup(f, "original", "edited");
  await fs.writeFile(f, "edited");
  cp.noteShell();
  cp.seal("edit and build");
  assert.equal((await cp.undo())!.ranShell, true);
});

test("the shell flag does not leak into the next turn", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  const cp = new Checkpoints();
  cp.noteShell();
  cp.seal("shell only"); // no files → no checkpoint, flag must reset

  await fs.writeFile(f, "original");
  cp.backup(f, "original", "edited");
  await fs.writeFile(f, "edited");
  cp.seal("quiet edit");
  assert.equal((await cp.undo())!.ranShell, false);
});

// NOTE: the `failed` branch (a file that reads back exactly as we wrote it but then
// refuses the write) can't be provoked portably — every way to make a file unwritable
// on both Windows and POSIX also makes it unreadable, which the conflict check catches
// first. The retirement arithmetic around it is covered by reasoning, not by a test:
// an earlier draft kept failed files forever and hung this suite in an infinite retry,
// which is what MAX_UNDO_ATTEMPTS exists to prevent.

test("the checkpoint stack is bounded", async () => {
  const cp = new Checkpoints(3);
  for (let i = 0; i < 6; i++) {
    cp.backup(`/nope/${i}`, "x", "y"); // paths don't need to exist for the bound test
    cp.seal(`turn ${i}`);
  }
  assert.equal(cp.nextUndoLabel(), "turn 5");
  let count = 0;
  while (cp.hasUndo()) {
    await cp.undo();
    count++;
  }
  assert.equal(count, 3);
});

// ── what the model is told ────────────────────────────────────────────────────
const result = (over: Partial<UndoResult> = {}): UndoResult => ({
  label: "add the parser",
  at: 0,
  restored: [],
  conflicts: [],
  failed: [],
  retryable: false,
  skipped: [],
  ranShell: false,
  ...over,
});

test("the undo notice states what is gone, what stands, and what is uncovered", () => {
  const text = undoNotice(
    [result({ restored: ["/p/a.ts"], conflicts: ["/p/b.ts"], failed: ["/p/c.ts"], skipped: ["/p/d.ts"], ranShell: true })],
    (p) => p.replace("/p/", ""),
  );
  assert.match(text, /add the parser/);
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) assert.match(text, new RegExp(f.replace(".", "\\.")));
  assert.match(text, /Shell commands/);
  assert.match(text, /Re-read/);
});

test("the notice mentions only the categories that actually happened", () => {
  const text = undoNotice([result({ restored: ["/p/a.ts"] })], (p) => p);
  assert.doesNotMatch(text, /changed after you wrote them/);
  assert.doesNotMatch(text, /Shell commands/);
  assert.doesNotMatch(text, /Too large/);
});

test("the notice folds several rolled-back turns into one statement", () => {
  const text = undoNotice(
    [result({ label: "second", restored: ["/a"] }), result({ label: "first", restored: ["/a", "/b"] })],
    (p) => p,
  );
  assert.match(text, /"second", "first"/);
  // /a was rolled back in both; it should be named once, not twice.
  assert.equal(text.match(/\/a\b/g)?.length, 1);
});

// ── /undo's argument (C6) ─────────────────────────────────────────────────────
test("a bare /undo rolls back one turn", () => {
  assert.deepEqual(parseUndoArg(""), { kind: "undo", count: 1 });
  assert.deepEqual(parseUndoArg("   "), { kind: "undo", count: 1 });
});

test("/undo list asks for the stack", () => {
  assert.deepEqual(parseUndoArg("list"), { kind: "list" });
  assert.deepEqual(parseUndoArg("LIST"), { kind: "list" });
});

test("/undo <n> rolls back n turns; nonsense is refused, not guessed", () => {
  assert.deepEqual(parseUndoArg("3"), { kind: "undo", count: 3 });
  assert.equal(parseUndoArg("0").kind, "error");
  assert.equal(parseUndoArg("-2").kind, "error");
  assert.equal(parseUndoArg("everything").kind, "error");
});

test("list shows what is available, newest first", async () => {
  const dir = tmp();
  const cp = new Checkpoints();
  for (const n of ["one", "two"]) {
    const f = join(dir, `${n}.txt`);
    await fs.writeFile(f, "before");
    cp.backup(f, "before", "after");
    await fs.writeFile(f, "after");
    cp.seal(n);
  }
  const rows = cp.list();
  assert.deepEqual(rows.map((r) => r.label), ["two", "one"]);
  assert.equal(rows[0]!.files, 1);
});

test("undoMany unwinds several turns, newest first", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "base");
  const cp = new Checkpoints();
  for (const v of ["v1", "v2", "v3"]) {
    const before = await fs.readFile(f, "utf8");
    cp.backup(f, before, v);
    await fs.writeFile(f, v);
    cp.seal(`to ${v}`);
  }
  const results = await cp.undoMany(2);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.label), ["to v3", "to v2"]);
  assert.equal(await fs.readFile(f, "utf8"), "v1", "two turns back, not three");
  assert.equal(cp.hasUndo(), true, "the first turn is still there");
});

test("undoMany stops at the end of the stack instead of erroring", async () => {
  const cp = new Checkpoints();
  assert.deepEqual(await cp.undoMany(5), []);
});

// ── memory bounds (C4) ────────────────────────────────────────────────────────
test("a file too large to hold is skipped and reported, never silently dropped", async () => {
  const dir = tmp();
  const big = join(dir, "big.bin");
  const huge = "x".repeat(5 * 1024 * 1024); // past the 4MB per-file ceiling
  const cp = new Checkpoints();
  cp.backup(big, huge, huge);
  cp.seal("wrote something enormous");

  // It still seals: the turn has nothing to restore but something to say.
  assert.equal(cp.hasUndo(), true);
  const r = await cp.undo();
  assert.deepEqual(r!.skipped, [big]);
  assert.deepEqual(r!.restored, []);
});

test("a skipped file is named in what the model is told", () => {
  const text = undoNotice([result({ skipped: ["/p/big.bin"] })], (p) => p);
  assert.match(text, /Too large to checkpoint/);
  assert.match(text, /big\.bin/);
});

test("the stack is bounded in bytes, not just in turns", async () => {
  const cp = new Checkpoints(50); // deliberately past the count bound, so bytes decide
  // 1.5MB per copy → 3MB held per file, comfortably under the 4MB per-file ceiling
  // so these are really held rather than skipped. 15 turns is 45MB against a 32MB
  // budget, so the oldest must go.
  const chunk = "y".repeat(1_500_000);
  for (let i = 0; i < 15; i++) {
    cp.backup(`/nope/${i}.txt`, chunk, chunk);
    cp.seal(`turn ${i}`);
  }
  const rows = cp.list();
  assert.ok(rows.length < 15, `old checkpoints should have been evicted, kept ${rows.length}`);
  assert.equal(rows[0]!.label, "turn 14", "the newest is always kept");
  assert.equal(rows[0]!.files, 1, "and it is a real checkpoint, not an all-skipped one");
});

test("one turn cannot blow the budget — the excess is skipped, not held", async () => {
  // This is what actually bounds a single turn: `backup` refuses once the turn's
  // held bytes would pass the budget. It is also why a lone checkpoint can never
  // exceed it, which is worth pinning — an earlier version of this test asserted
  // the opposite case and passed for the wrong reason.
  const cp = new Checkpoints();
  const chunk = "z".repeat(1_000_000); // 2MB held per file
  for (let i = 0; i < 40; i++) cp.backup(`/nope/${i}.txt`, chunk, chunk); // 80MB if unbounded
  cp.seal("one enormous turn");
  const r = await cp.undo();
  assert.ok(r!.skipped.length > 0, "the excess must be reported, not silently dropped");
  assert.ok(r!.skipped.length < 40, "and the budget's worth should still have been held");
});

// ── resumed sessions (C7) ─────────────────────────────────────────────────────
test("a resumed session knows its history was dropped, not that nothing happened", () => {
  const fresh = new Checkpoints();
  assert.equal(fresh.wasResumed(), false);
  const resumed = new Checkpoints();
  resumed.noteResumed();
  assert.equal(resumed.wasResumed(), true);
  assert.equal(resumed.hasUndo(), false, "resuming carries no undo history");
});
