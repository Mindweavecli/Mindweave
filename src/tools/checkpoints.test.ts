import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "./checkpoints.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mindweave-cp-"));
}

test("undo restores an edited file's original content", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "original");
  const cp = new Checkpoints();
  cp.backup(f, "original");
  await fs.writeFile(f, "edited");
  cp.seal("edit a");
  const r = await cp.undo();
  assert.ok(r);
  assert.deepEqual(r!.restored, [f]);
  assert.equal(await fs.readFile(f, "utf8"), "original");
});

test("undo deletes a file the turn created (original was null)", async () => {
  const dir = tmp();
  const f = join(dir, "new.txt");
  const cp = new Checkpoints();
  cp.backup(f, null); // didn't exist before
  await fs.writeFile(f, "brand new");
  cp.seal("create new");
  await cp.undo();
  assert.equal(await fs.stat(f).then(() => true, () => false), false, "file should be gone");
});

test("first touch wins: a file edited twice in a turn restores to its pre-turn state", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  await fs.writeFile(f, "v0");
  const cp = new Checkpoints();
  cp.backup(f, "v0");
  await fs.writeFile(f, "v1");
  cp.backup(f, "v1"); // second touch — must NOT overwrite the v0 backup
  await fs.writeFile(f, "v2");
  cp.seal("two edits");
  await cp.undo();
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

  cp.backup(f, "base");
  await fs.writeFile(f, "turn1");
  cp.seal("turn 1");

  cp.backup(f, "turn1");
  await fs.writeFile(f, "turn2");
  cp.seal("turn 2");

  assert.equal(cp.nextUndoLabel(), "turn 2");
  await cp.undo(); // back to turn1's state
  assert.equal(await fs.readFile(f, "utf8"), "turn1");
  await cp.undo(); // back to base
  assert.equal(await fs.readFile(f, "utf8"), "base");
  assert.equal(cp.hasUndo(), false);
});

test("the checkpoint stack is bounded", async () => {
  const cp = new Checkpoints(3);
  for (let i = 0; i < 6; i++) {
    cp.backup(`/nope/${i}`, "x"); // paths don't need to exist for the bound test
    cp.seal(`turn ${i}`);
  }
  // Only the last 3 survive; the oldest reachable label is "turn 5".
  assert.equal(cp.nextUndoLabel(), "turn 5");
  let count = 0;
  while (cp.hasUndo()) {
    await cp.undo();
    count++;
  }
  assert.equal(count, 3);
});
