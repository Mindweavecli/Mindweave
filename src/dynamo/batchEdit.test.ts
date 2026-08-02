/**
 * batchEdit.test.ts — the mechanical answer to a routing decision the model makes badly
 * some of the time.
 *
 * Why this is not a tool-description change: measured against a real model, the identical
 * task with identical descriptions batched correctly on one run and made three separate
 * `edit_file` calls to one file on the next. Prose can bias a choice; it cannot make it
 * hold. And this tool ships to every provider, so "tune the driver" is not available
 * either — a driver owns format, never behaviour. Anything that must be true on every
 * model has to be enforced by the harness. Same reasoning as the verify gate and the
 * repeat-failure breaker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAME_FILE_EDIT_LIMIT, batchEditNudge, overusedSingleEdits, sameFileEditCounts } from "./verify.js";

const call = (name: string, path?: string) => ({ name, args: path ? { path } : {} });

test("only single edit_file calls are counted", () => {
  const counts = sameFileEditCounts([
    call("edit_file", "a.py"),
    call("edit_file", "a.py"),
    call("multi_edit", "a.py"), // already the batched form
    call("write_file", "a.py"), // a different decision entirely
    call("read_file", "a.py"),
    call("edit_file", "b.py"),
  ]);
  assert.equal(counts.get("a.py"), 2);
  assert.equal(counts.get("b.py"), 1);
  assert.equal(counts.size, 2);
});

test("an edit_file with no path is ignored rather than counted under a blank key", () => {
  const counts = sameFileEditCounts([call("edit_file"), call("edit_file", "   ")]);
  assert.equal(counts.size, 0);
});

test("two edits to one file are fine — the second is often what the first revealed", () => {
  assert.equal(overusedSingleEdits(new Map([["a.py", SAME_FILE_EDIT_LIMIT]])), null);
});

test("the third edit to the SAME file trips it", () => {
  assert.equal(overusedSingleEdits(new Map([["a.py", SAME_FILE_EDIT_LIMIT + 1]])), "a.py");
});

test("edits spread across DIFFERENT files never trip it", () => {
  // One call per file is the intended shape. Only repetition on one file is the smell.
  const spread = new Map([
    ["a.py", 1],
    ["b.py", 2],
    ["c.py", 1],
    ["d.py", 2],
  ]);
  assert.equal(overusedSingleEdits(spread), null);
});

test("the nudge says what to do, and what NOT to do", () => {
  const msg = batchEditNudge("monitor/middleware.py", 3);
  assert.match(msg, /3 separate edit_file calls to monitor\/middleware\.py/, "the fact, so it isn't abstract");
  assert.match(msg, /single multi_edit call/, "the remedy");
  assert.match(msg, /one call per file/, "and the boundary, so it doesn't over-correct into one giant call");
  assert.match(msg, /fires once per turn/, "so it reads as a reminder, not a rule it broke");
});
