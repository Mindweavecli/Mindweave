/**
 * detail.test.ts — the display-only rich blocks (edit diff, write preview,
 * command output, and line capping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capLines, editDetail, outputDetail, writeDetail, lineCount, rangeLabel, magnitude, withScope } from "./detail.js";

test("editDetail shows removed then added lines, prefixed", () => {
  const d = editDetail("a\nb", "a\nc");
  assert.equal(d, "- a\n- b\n+ a\n+ c");
});

test("editDetail ignores a single trailing newline on each side", () => {
  assert.equal(editDetail("x\n", "y\n"), "- x\n+ y");
});

test("writeDetail previews a new file as all-additions", () => {
  assert.equal(writeDetail("line1\nline2"), "+ line1\n+ line2");
  assert.equal(writeDetail(""), "");
});

test("outputDetail passes command output through plain (no prefixes)", () => {
  assert.equal(outputDetail("hello\nworld"), "hello\nworld");
  assert.equal(outputDetail(""), "");
});

test("capLines truncates with a count once over the max", () => {
  assert.equal(capLines(["a", "b", "c"], 5), "a\nb\nc");
  assert.equal(capLines(["a", "b", "c", "d"], 2), "a\nb\n  … (2 more lines)");
  assert.equal(capLines(["a", "b"], 1), "a\n  … (1 more line)");
});

test("lineCount counts replacement lines (empty spans none)", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("one line"), 1);
  assert.equal(lineCount("a\nb\nc"), 3);
});

test("rangeLabel: one line vs a span", () => {
  assert.equal(rangeLabel(120, 120), "L120");
  assert.equal(rangeLabel(120, 138), "L120-138");
});

test("magnitude uses a real minus sign, not the diff hyphen", () => {
  assert.equal(magnitude(6, 12), "−6 +12");
  assert.ok(!magnitude(6, 12).startsWith("-"), "must not start with an ASCII hyphen");
});

test("withScope prepends the scope header above the body", () => {
  assert.equal(withScope("L1-3 · −1 +2", "- a\n+ b\n+ c"), "L1-3 · −1 +2\n- a\n+ b\n+ c");
  assert.equal(withScope("new file · 2 lines", ""), "new file · 2 lines");
});
