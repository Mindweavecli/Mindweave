/**
 * engine.test.ts — stopReasonNote (pure).
 *
 * The full agent loop isn't unit-tested here (it needs a live session and tool
 * context), but the wording shown to the user when a turn ends early is pure and
 * worth pinning: every non-"end" StopReason must produce a distinct, honest
 * explanation, so a truncated reply is never confused with a refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopReasonNote } from "./engine.js";
import type { StopReason } from "../drivers/types.js";

test("every early-stop reason gets its own, distinct explanation", () => {
  const reasons: Exclude<StopReason, "end">[] = ["truncated", "refused", "overflow", "overloaded"];
  const notes = reasons.map(stopReasonNote);
  assert.equal(new Set(notes).size, reasons.length, "two different reasons produced the same wording");
  for (const note of notes) assert.ok(note.length > 0);
});

test("truncated and overloaded both read as incomplete, but name a different cause", () => {
  const truncated = stopReasonNote("truncated");
  const overloaded = stopReasonNote("overloaded");
  assert.match(truncated, /incomplete/);
  assert.match(overloaded, /incomplete/);
  assert.notEqual(truncated, overloaded);
});
