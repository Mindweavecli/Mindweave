/**
 * pasteAssembler.test.ts — the bracketed-paste chunk reassembler. Simulates the
 * chunked `input` events Ink hands us for a paste and asserts we rebuild exactly one
 * paste, markers stripped, regardless of how the terminal split it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedPasteChunk, initPasteState, type PasteStep } from "./pasteAssembler.js";

const ESC = "\x1b";
const START = ESC + "[200~";
const END = ESC + "[201~";

/** Feed a sequence of chunks; return the flushed text, or null if never flushed. */
function run(chunks: string[]): { flushed: string | null; passthrough: string[] } {
  let state = initPasteState();
  let flushed: string | null = null;
  const passthrough: string[] = [];
  for (const chunk of chunks) {
    const step: PasteStep = feedPasteChunk(state, chunk);
    if (step.kind === "passthrough") passthrough.push(chunk);
    else if (step.kind === "buffering") state = step.state;
    else flushed = step.text;
  }
  return { flushed, passthrough };
}

test("single-chunk paste with both markers flushes the content", () => {
  const { flushed } = run([START + "hello world" + END]);
  assert.equal(flushed, "hello world");
});

test("Ink strips the leading ESC from the start marker — still detected", () => {
  // First chunk as Ink delivers it: leading ESC gone, end marker keeps its ESC.
  const { flushed } = run(["[200~hello" + END]);
  assert.equal(flushed, "hello");
});

test("paste split across many chunks reassembles into one flush", () => {
  const parts = ["[200~aaaa", "bbbb", "cccc", "dddd" + END];
  const { flushed } = run(parts);
  assert.equal(flushed, "aaaabbbbccccdddd");
});

test("only one flush happens (no per-chunk flushing)", () => {
  let state = initPasteState();
  const steps: string[] = [];
  for (const chunk of ["[200~one", "two", "three" + END]) {
    const step = feedPasteChunk(state, chunk);
    steps.push(step.kind);
    if (step.kind === "buffering") state = step.state;
  }
  assert.deepEqual(steps, ["buffering", "buffering", "flush"]);
});

test("newlines inside the paste are preserved", () => {
  const body = "line1\nline2\nline3";
  const { flushed } = run([START + body + END]);
  assert.equal(flushed, body);
});

test("non-paste input passes through untouched", () => {
  const { flushed, passthrough } = run(["a", "b", "c"]);
  assert.equal(flushed, null);
  assert.deepEqual(passthrough, ["a", "b", "c"]);
});

test("a split end marker leaves no stray ESC in the result", () => {
  // Terminal splits `\x1b[201~` so the ESC lands at the end of one chunk and the
  // rest at the start of the next; the ESC-optional end regex catches the tail.
  const { flushed } = run(["[200~payload" + ESC, "[201~"]);
  assert.equal(flushed, "payload");
});

test("empty paste (markers only) flushes empty and is ignored by caller", () => {
  const { flushed } = run([START + END]);
  assert.equal(flushed, "");
});
