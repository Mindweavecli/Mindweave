/**
 * treesitterLangs.test.ts — broad language coverage, part 1 of 3 (split so no single
 * process loads too many grammar wasms — that exhausts V8's heap; see langCases.ts).
 * Runs against the real grammars, so a query that stops compiling fails loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLang, type LangCase } from "./langCases.js";
import { treeSitterExtract } from "./treesitter.js";

const CASES: LangCase[] = [
  { file: "a.go", code: "package main\nfunc Hello() int { return doThing() }", expect: { name: "Hello", kind: "function" } },
  { file: "a.rs", code: "struct Foo {}\nfn hello() -> i32 { do_thing() }", expect: { name: "Foo", kind: "struct" } },
  { file: "a.java", code: "class Foo { void bar() { baz(); } }", expect: { name: "Foo", kind: "class" } },
  { file: "a.cpp", code: "class Foo { public: void bar(); };", expect: { name: "Foo", kind: "class" } },
  { file: "a.php", code: "<?php\nfunction hello() { return doThing(); }", expect: { name: "hello", kind: "function" } },
];

for (const c of CASES) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}

test("a def carries an end line so its span/outline nests", async () => {
  const ex = await treeSitterExtract("a.go", "package main\nfunc Hello() int {\n  return 1\n}");
  const fn = ex!.defs.find((d) => d.name === "Hello")!;
  assert.ok(fn.endLine && fn.endLine > fn.line, "Hello should span multiple lines");
});
