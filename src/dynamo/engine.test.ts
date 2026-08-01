/**
 * engine.test.ts — stopReasonNote (pure) + the pause paths' one structural rule.
 *
 * The full agent loop isn't unit-tested here (it needs a live session and tool
 * context), but the wording shown to the user when a turn ends early is pure and
 * worth pinning: every non-"end" StopReason must produce a distinct, honest
 * explanation, so a truncated reply is never confused with a refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// Every pause must reach the SCREEN, not just the transcript.
//
// A source scan, which is unusual, and deliberate. This bug cannot fail loudly:
// a pause helper that only pushes to the transcript type-checks, passes every
// test, and returns a perfectly good string — the turn just ends with a blank
// screen and the user reads it as a crash. That happened. The only mechanical way
// to catch the next one is to check the shape of the code, the same approach
// promptAssembly.test.ts and providerNeutrality.test.ts take for their own
// silent failures.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("endTurnWith puts the pause message on the wire, not only in the transcript", () => {
  const body = engineSource.match(/function endTurnWith\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "endTurnWith not found — did it get renamed?");
  assert.match(body, /transcript\.push/, "the pause must be recorded for the next model turn");
  assert.match(body, /onEvent\?\.\(\s*\{\s*type:\s*"text"/, "the pause must also be emitted to the UI");
});

test("no pause helper ends a turn without going through endTurnWith", () => {
  const helpers = [...engineSource.matchAll(/\nfunction (pause\w*)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
  assert.ok(helpers.length >= 4, `expected the known pause helpers, found ${helpers.length}`);
  for (const [, name, body] of helpers) {
    assert.match(
      body!,
      /endTurnWith\(/,
      `${name} composes a message the user never sees — route it through endTurnWith`,
    );
  }
});
