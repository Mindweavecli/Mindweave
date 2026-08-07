/**
 * treesitterLangs.test.ts — broad language coverage, part 1 of 4 (split so no single
 * process loads too many grammar wasms — that exhausts V8's heap; see langCases.ts,
 * which owns the cases and the byte budget the split is balanced against).
 * Runs against the real grammars, so a query that stops compiling fails loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLang, PART1 } from "./langCases.js";
import { treeSitterExtract } from "./treesitter.js";

for (const c of PART1) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}

test("a def carries an end line so its span/outline nests", async () => {
  const ex = await treeSitterExtract("a.go", "package main\nfunc Hello() int {\n  return 1\n}");
  const fn = ex!.defs.find((d) => d.name === "Hello")!;
  assert.ok(fn.endLine && fn.endLine > fn.line, "Hello should span multiple lines");
});
