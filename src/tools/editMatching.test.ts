/**
 * editMatching.test.ts — the tiered matcher, and the line it refuses to cross.
 *
 * Two opposite failure modes are in tension here, and most of these tests exist to pin
 * the tradeoff rather than any single behaviour:
 *
 *   - Too strict, and an indentation difference the model cannot even see costs a turn.
 *   - Too loose, and the tool confidently edits the wrong block. That is the documented,
 *     still-open failure mode of the "stack many replacers, first hit wins" design, and
 *     it is far worse than a refusal, because a refusal is visible and a bad edit is not.
 *
 * So: line-trimmed matching is allowed, block-anchor guessing is not, and every tier
 * counts matches across the whole file before touching anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOneEdit, describeMatches, findMatches, lineAt } from "./editCore.js";

const FILE = `class Alpha:
    def handle(self, request):
        ip = self._get_ip(request)
        return ip

    @staticmethod
    def _get_ip(request):
        return request.META.get("REMOTE_ADDR")


class Beta:
    def handle(self, request):
        ip = self._get_ip(request)
        return ip

    @staticmethod
    def _get_ip(request):
        return request.META.get("REMOTE_ADDR")
`;

test("an exact match is found and applied", () => {
  const r = applyOneEdit("a\nb\nc\n", { oldString: "b", newString: "B", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.updated, "a\nB\nc\n");
});

test("indentation drift still matches — the failure the model cannot see", () => {
  // The model retyped the block with 2 spaces where the file has 4. The text is right;
  // only the leading whitespace differs. Rejecting this costs a whole turn for nothing.
  const r = applyOneEdit(FILE, {
    oldString: "  def handle(self, request):\n      ip = self._get_ip(request)\n      return ip",
    newString: "    def handle(self, request):\n        ip = client_ip(request)\n        return ip",
    replaceAll: true,
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.equal(r.count, 2);
    assert.ok(!r.updated.includes("self._get_ip(request)\n        return ip"));
  }
});

test("a line-trimmed match replaces the WHOLE line, so new_string's indentation wins", () => {
  // The semantic worth pinning: tier 2 matched a line whose leading whitespace differed
  // from what the model sent, so the file's version of that line is replaced outright.
  // The model's new_string therefore decides the resulting indentation — it is not
  // merged with the file's. Everything the match did not cover is untouched.
  const file = "def f():\n\t\tvalue = 1\n\t\treturn value\n";
  const r = applyOneEdit(file, {
    oldString: "    value = 1", // 4 spaces where the file has 2 tabs: no exact substring
    newString: "    value = 2",
    replaceAll: false,
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.updated, "def f():\n    value = 2\n\t\treturn value\n");
});

test("an exact substring match is preferred, and splices in place", () => {
  // The same edit where old_string IS an exact substring stays a substring splice —
  // tier 1 wins, so only the matched run changes and surrounding indentation stays.
  const file = "def f():\n\t\tvalue = 1\n\t\treturn value\n";
  const r = applyOneEdit(file, { oldString: "value = 1", newString: "value = 2", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.updated, "def f():\n\t\tvalue = 2\n\t\treturn value\n");
});

test("a line-trimmed match cannot skip or reorder lines", () => {
  // The guardrail on tier 2: the sequence of lines must correspond exactly. Without
  // this, "first line ... last line" anchoring would swallow whatever sits between.
  const r = applyOneEdit(FILE, {
    oldString: "class Alpha:\n        return ip",
    newString: "nope",
    replaceAll: false,
  });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.reason, /not found/);
});

test("an ambiguous match REFUSES rather than picking one", () => {
  // The corruption-prevention property. Two identical helpers; guessing either is a
  // silent wrong edit, so the tool declines and says where they are.
  const r = applyOneEdit(FILE, {
    oldString: "    @staticmethod\n    def _get_ip(request):",
    newString: "",
    replaceAll: false,
  });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.match(r.reason, /matches 2 places/);
    assert.match(r.reason, /replace_all: true/, "the remedy has to be named, not implied");
  }
});

test("an ambiguous EXACT match never falls through to a looser tier", () => {
  // The specific bug in first-hit-wins designs: an exact match that was ambiguous gets
  // "resolved" by a lenient tier that happens to find one candidate, and the edit lands
  // somewhere the model never looked. Tier 1 finding 2 must end the search.
  const found = findMatches(FILE, "    @staticmethod\n    def _get_ip(request):");
  assert.equal(found.tier, "exact");
  assert.equal(found.matches.length, 2);
});

test("the ambiguity report gives the model something to act on", () => {
  const found = findMatches(FILE, "    @staticmethod\n    def _get_ip(request):");
  const report = describeMatches(FILE, found.matches);
  // Line numbers for each candidate...
  assert.match(report, /1\. line 6/);
  assert.match(report, /2\. line 16/);
  // ...and the candidate line marked, so it needn't be counted by eye.
  assert.match(report, /^>\s+6 \|\s+@staticmethod$/m);
  // ...and, critically, context WIDE ENOUGH to tell the candidates apart. Two identical
  // helpers on two similar classes render identically at a narrow window, which leaves
  // the model exactly where it started; the report grows until something differs.
  assert.match(report, /class Alpha:/);
  assert.match(report, /class Beta:/);
});

test("the report is bounded, and always names both ways out", () => {
  // A file with many occurrences must not turn one refusal into a wall of text.
  const periodic = "p\nq\n".repeat(20);
  const found = findMatches(periodic, "p\nq");
  assert.equal(found.matches.length, 20);
  const report = describeMatches(periodic, found.matches);
  assert.equal((report.match(/^\s+\d+\. line /gm) ?? []).length, 4, "at most 4 candidates are shown");
  assert.match(report, /… and 16 more/, "and the rest are counted, not hidden");
  // Both remedies, every time: a longer anchor, or replace_all.
  assert.match(report, /Extend old_string/);
  assert.match(report, /replace_all: true/);
});

test("replace_all changes every occurrence, and splices right-to-left", () => {
  // Right-to-left matters: replacing left-to-right shifts every later offset, so a
  // multi-site replace silently lands in the wrong place as the text grows or shrinks.
  const r = applyOneEdit("x1\nx2\nx1\nx2\nx1\n", { oldString: "x1", newString: "LONGER_TOKEN", replaceAll: true });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.updated, "LONGER_TOKEN\nx2\nLONGER_TOKEN\nx2\nLONGER_TOKEN\n");
    assert.equal(r.count, 3);
  }
});

test("a $ in the replacement is literal, not a pattern reference", () => {
  const r = applyOneEdit("const a = 1;\n", { oldString: "1", newString: "$&$1", replaceAll: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.updated, "const a = $&$1;\n");
});

test("not-found says what kind of difference is tolerated", () => {
  const r = applyOneEdit(FILE, { oldString: "def nonexistent():", newString: "x", replaceAll: false });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.reason, /leading\/trailing whitespace/);
});

test("lineAt reports 1-based lines", () => {
  assert.equal(lineAt("a\nb\nc", 0), 1);
  assert.equal(lineAt("a\nb\nc", 2), 2);
  assert.equal(lineAt("a\nb\nc", 4), 3);
});
