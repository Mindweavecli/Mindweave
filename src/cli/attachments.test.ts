/**
 * attachments.test.ts — file sharing (`@mention` + drag-and-drop): the model gets
 * the bytes, the chat gets a chip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAttachments, stripAttachments } from "./attachments.js";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mindweave-attach-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("@mention: full content to model, count-only chip to UI, mention stays visible", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "foo.ts"), "line1\nline2\nline3\n");
    const { modelText, displayText, notes } = await resolveAttachments("look at @foo.ts please", dir);

    assert.ok(modelText.includes('<attached_file path="foo.ts">'));
    assert.ok(modelText.includes("line2")); // full content reaches the model
    assert.equal(displayText, "look at @foo.ts please"); // mention left visible
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /attached foo\.ts \(\+4 lines\)/);
    assert.ok(!notes[0]!.includes("line2")); // chip is never the content
  });
});

test("dropped quoted path: content to model, path collapses to file name in chat", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "dropped.txt");
    await fs.writeFile(abs, "hello\nworld\n");
    // A drag-and-drop pastes the (quoted) absolute path into the buffer.
    const { modelText, displayText, notes } = await resolveAttachments(`"${abs}"`, dir);

    assert.ok(modelText.includes("hello")); // model gets the bytes
    assert.equal(displayText, "dropped.txt"); // chat shows just the file name
    assert.ok(!displayText.includes(abs)); // the ugly path is gone from the chat
    assert.match(notes[0]!, /attached dropped\.txt \(\+3 lines\)/);
  });
});

test("dropped bare absolute path collapses too", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "notes.md");
    await fs.writeFile(abs, "x\n");
    const { displayText, notes } = await resolveAttachments(`summarize ${abs}`, dir);
    assert.equal(displayText, "summarize notes.md");
    assert.equal(notes.length, 1);
  });
});

test("a mention that isn't a file is left as plain text", async () => {
  await withTmp(async (dir) => {
    const { modelText, displayText, notes } = await resolveAttachments("ping @someone about it", dir);
    assert.equal(modelText, "ping @someone about it");
    assert.equal(displayText, "ping @someone about it");
    assert.equal(notes.length, 0);
  });
});

test("a quoted phrase that isn't a path is left untouched", async () => {
  await withTmp(async (dir) => {
    const { displayText, notes } = await resolveAttachments('he said "hello world" today', dir);
    assert.equal(displayText, 'he said "hello world" today');
    assert.equal(notes.length, 0);
  });
});

test("trailing punctuation is trimmed off a mention", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "a.txt"), "x\n");
    const { notes } = await resolveAttachments("see @a.txt.", dir);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /attached a\.txt/);
  });
});

test("a duplicate reference attaches once", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "a.txt"), "x\n");
    const { notes } = await resolveAttachments("@a.txt and again @a.txt", dir);
    assert.equal(notes.length, 1);
  });
});

test("non-image binary files are skipped with a note, not attached", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "blob.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const { modelText, notes } = await resolveAttachments("@blob.dat", dir);
    assert.ok(!modelText.includes("<attached_file"));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /skipped blob\.dat \(binary file/);
  });
});

test("images are recognized and acknowledged, but not sent (text model)", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const { modelText, displayText, notes } = await resolveAttachments(`look at @shot.png`, dir);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /attached image shot\.png \(I can't read images/);
    assert.ok(modelText.includes("shared an image file: shot.png")); // model is told, no bytes
    assert.ok(!modelText.includes("<attached_file")); // not a text attachment
    assert.equal(displayText, "look at @shot.png");
  });
});

test("stripAttachments hides the payload but keeps the typed line", () => {
  const modelText = 'look at @foo.ts\n\n<attached_file path="foo.ts">\nsecret body\n</attached_file>';
  const shown = stripAttachments(modelText);
  assert.equal(shown, "look at @foo.ts");
  assert.ok(!shown.includes("secret body"));
});
