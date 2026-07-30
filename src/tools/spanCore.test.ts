import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenDocSymbols,
  pickNearest,
  sliceBody,
  rawLines,
  spliceLines,
  type RawDocSymbol,
} from "./spanCore.js";

test("flattenDocSymbols reads hierarchical DocumentSymbol (range + children)", () => {
  const raw: RawDocSymbol[] = [
    {
      name: "Foo",
      range: { start: { line: 0 }, end: { line: 9 } },
      children: [{ name: "bar", range: { start: { line: 2 }, end: { line: 4 } } }],
    },
  ];
  const flat = flattenDocSymbols(raw);
  // 1-based, inclusive; children flattened too.
  assert.deepEqual(flat, [
    { name: "Foo", start: 1, end: 10 },
    { name: "bar", start: 3, end: 5 },
  ]);
});

test("flattenDocSymbols reads flat SymbolInformation (location.range)", () => {
  const raw: RawDocSymbol[] = [
    { name: "baz", location: { range: { start: { line: 4 }, end: { line: 6 } } } },
  ];
  assert.deepEqual(flattenDocSymbols(raw), [{ name: "baz", start: 5, end: 7 }]);
});

test("flattenDocSymbols tolerates missing/garbage entries", () => {
  assert.deepEqual(flattenDocSymbols(null), []);
  assert.deepEqual(flattenDocSymbols([{ name: "x" }, { range: { start: { line: 1 }, end: { line: 2 } } }]), []);
});

test("pickNearest chooses the span closest to the hint line", () => {
  const spans = [
    { start: 5, end: 9 },
    { start: 40, end: 55 },
  ];
  assert.deepEqual(pickNearest(spans, 42), { start: 40, end: 55 });
  assert.deepEqual(pickNearest(spans), { start: 5, end: 9 }); // no hint → first
  assert.equal(pickNearest([]), null);
});

const SAMPLE = "line one\nline two\nline three\nline four\nline five";

test("sliceBody returns the inclusive line range, line-numbered", () => {
  const body = sliceBody(SAMPLE, 2, 4);
  assert.equal(body, "2\tline two\n3\tline three\n4\tline four");
});

test("sliceBody clamps an over-long end to the file", () => {
  assert.equal(sliceBody(SAMPLE, 4, 999), "4\tline four\n5\tline five");
});

test("rawLines returns the range without numbers", () => {
  assert.equal(rawLines(SAMPLE, 2, 3), "line two\nline three");
});

test("spliceLines replaces the inclusive range and keeps the rest", () => {
  const out = spliceLines(SAMPLE, 2, 4, "NEW A\nNEW B");
  assert.equal(out, "line one\nNEW A\nNEW B\nline five");
});

test("spliceLines is EOL-agnostic on input (works on CRLF content)", () => {
  const crlf = "a\r\nb\r\nc\r\nd";
  // Replace line 2..3 ("b","c"). Output is LF (caller re-applies the file's EOL).
  assert.equal(spliceLines(crlf, 2, 3, "X"), "a\nX\nd");
});

test("spliceLines replacing the first and last lines", () => {
  assert.equal(spliceLines(SAMPLE, 1, 1, "TOP"), "TOP\nline two\nline three\nline four\nline five");
  assert.equal(spliceLines(SAMPLE, 5, 5, "END"), "line one\nline two\nline three\nline four\nEND");
});
