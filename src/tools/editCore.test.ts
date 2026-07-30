import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOneEdit, applyEditSequence, occurrences } from "./editCore.js";

test("occurrences counts non-overlapping matches (empty needle = 0)", () => {
  assert.equal(occurrences("aXbXc", "X"), 2);
  assert.equal(occurrences("abc", "z"), 0);
  assert.equal(occurrences("abc", ""), 0);
});

test("applyOneEdit replaces a unique match and reports the span", () => {
  const r = applyOneEdit("one two three", { oldString: "two", newString: "TWO", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.updated, "one TWO three");
    assert.equal(r.count, 1);
    assert.equal(r.changeStart, 4);
    assert.equal(r.changeEnd, 7);
  }
});

test("applyOneEdit rejects a not-found match", () => {
  const r = applyOneEdit("abc", { oldString: "zzz", newString: "y", replaceAll: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not found/);
});

test("applyOneEdit rejects an ambiguous match without replace_all", () => {
  const r = applyOneEdit("x x x", { oldString: "x", newString: "y", replaceAll: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /matches 3 places/);
});

test("applyOneEdit replace_all changes every occurrence", () => {
  const r = applyOneEdit("x x x", { oldString: "x", newString: "y", replaceAll: true });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.updated, "y y y");
    assert.equal(r.count, 3);
  }
});

test("applyOneEdit treats a `$` in the replacement literally", () => {
  const r = applyOneEdit("price here", { oldString: "price here", newString: "$9.99 ($&)", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.updated, "$9.99 ($&)");
});

test("applyOneEdit normalizes CRLF so an LF old_string matches a CRLF file", () => {
  const r = applyOneEdit("a\r\nb\r\nc", { oldString: "a\nb", newString: "A\nB", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.updated, "A\nB\nc"); // normalized to LF; the tool re-applies EOL
});

test("applyEditSequence applies edits in order, each seeing the last", () => {
  const r = applyEditSequence("hello world", [
    { oldString: "hello", newString: "hi", replaceAll: false },
    { oldString: "hi world", newString: "hi there", replaceAll: false },
  ]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.updated, "hi there");
    assert.equal(r.total, 2);
  }
});

test("applyEditSequence is atomic: a mid-sequence failure aborts with the index", () => {
  const r = applyEditSequence("alpha beta", [
    { oldString: "alpha", newString: "ALPHA", replaceAll: false },
    { oldString: "nope", newString: "x", replaceAll: false }, // fails
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.index, 1);
    assert.match(r.reason, /not found/);
  }
});
