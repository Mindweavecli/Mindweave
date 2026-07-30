import { test } from "node:test";
import assert from "node:assert/strict";
import { addFocus } from "./focus.js";

test("addFocus starts a list and returns existing on no span", () => {
  assert.deepEqual(addFocus(undefined, { start: 10, end: 20 }), [{ start: 10, end: 20 }]);
  assert.equal(addFocus(undefined, undefined), undefined);
});

test("addFocus merges overlapping and adjacent spans", () => {
  let f = addFocus(undefined, { start: 10, end: 20 });
  f = addFocus(f, { start: 18, end: 25 }); // overlaps → merge
  assert.deepEqual(f, [{ start: 10, end: 25 }]);
  f = addFocus(f, { start: 26, end: 30 }); // adjacent (end+1) → merge
  assert.deepEqual(f, [{ start: 10, end: 30 }]);
});

test("addFocus keeps disjoint spans sorted and caps to the most recent", () => {
  let f: ReturnType<typeof addFocus>;
  f = addFocus(undefined, { start: 100, end: 110 });
  f = addFocus(f, { start: 1, end: 5 });
  f = addFocus(f, { start: 50, end: 55 });
  assert.deepEqual(f, [{ start: 1, end: 5 }, { start: 50, end: 55 }, { start: 100, end: 110 }]);
  // Over the cap → keeps the highest-line (most recent) spans.
  f = addFocus(f, { start: 200, end: 205 });
  f = addFocus(f, { start: 300, end: 305 }, 3);
  assert.equal(f!.length, 3);
  assert.deepEqual(f!.at(-1), { start: 300, end: 305 });
});
