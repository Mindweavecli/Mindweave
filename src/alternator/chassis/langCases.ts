/**
 * langCases.ts — shared checker and case list for the broad-language tests.
 *
 * Loading every grammar wasm in one process exhausts V8's heap, and Node's test
 * runner isolates each test FILE in its own process — so the language cases are
 * split across several test files, each exercising `checkLang` on one PART.
 * Keeping the assertion here means every part verifies identically.
 *
 * The parts are balanced by GRAMMAR BYTES, not by case count, because grammars
 * differ in size by more than a hundredfold (lua 43KB, ocaml 5MB) and an even count
 * of cases says nothing about the real cost. `PART_BUDGET_BYTES` keeps that from
 * drifting: `langBudget.test.ts` weighs the real wasm files and fails when a part
 * exceeds it, so adding a heavy grammar forces a deliberate re-split.
 *
 * WHAT THIS SPLIT DOES NOT FIX, since the wrong story was believed for a while:
 * the suite's intermittent `Fatal process out of memory: Zone` crash is NOT caused
 * by the balance between parts. It is the `ocaml` grammar, which is the largest and
 * tips V8 over when the machine is already under memory pressure. Measured: the
 * crash still happened with file concurrency forced to 1, and it FOLLOWED ocaml
 * from one part to another when the cases were moved. The actual fix is the heap
 * headroom (`--max-old-space-size`) and the sequential `test:lang` phase in
 * package.json. Balancing the parts is still worth keeping, but do not reach for it
 * when that crash comes back.
 */
import assert from "node:assert/strict";
import { treeSitterExtract, isSupported } from "./treesitter.js";

export interface LangCase {
  file: string;
  code: string;
  expect: { name: string; kind: string };
}

/** Assert a language's headline symbol extracts, against its real grammar. */
export async function checkLang(c: LangCase): Promise<void> {
  assert.ok(isSupported(c.file), `${c.file} should be a supported language`);
  const ex = await treeSitterExtract(c.file, c.code);
  assert.ok(ex, `extraction returned null for ${c.file}`);
  const hit = ex!.defs.find((d) => d.name === c.expect.name);
  assert.ok(hit, `expected def '${c.expect.name}' in ${c.file}, got: ${ex!.defs.map((d) => d.name).join(", ") || "(none)"}`);
  assert.equal(hit!.kind, c.expect.kind);
}

/**
 * Ceiling on the grammar bytes any one part may load. Set above the current
 * heaviest part (~6.1MB) with room for an ordinary grammar. A part that exceeds
 * this should be re-split rather than the budget raised.
 */
export const PART_BUDGET_BYTES = 7_000_000;

// The four parts, packed heaviest-grammar-first so no part carries two of the big
// ones. Approximate wasm size is noted per case, since that is the property being
// balanced and it is otherwise invisible when editing this list.
export const PART1: LangCase[] = [
  { file: "a.ml", code: "let hello x = do_thing x", expect: { name: "hello", kind: "function" } }, // ocaml ~5.0MB
  { file: "a.c", code: "int hello() { return do_thing(); }", expect: { name: "hello", kind: "function" } }, // ~0.8MB
  { file: "a.go", code: "package main\nfunc Hello() int { return doThing() }", expect: { name: "Hello", kind: "function" } }, // ~0.2MB
];

export const PART2: LangCase[] = [
  { file: "a.cpp", code: "class Foo { public: void bar(); };", expect: { name: "Foo", kind: "class" } }, // ~4.7MB
  { file: "a.php", code: "<?php\nfunction hello() { return doThing(); }", expect: { name: "hello", kind: "function" } }, // ~0.8MB
  { file: "a.java", code: "class Foo { void bar() { baz(); } }", expect: { name: "Foo", kind: "class" } }, // ~0.4MB
  { file: "a.lua", code: "function hello()\n  return doThing()\nend", expect: { name: "hello", kind: "function" } }, // ~0.04MB
];

export const PART3: LangCase[] = [
  { file: "a.kt", code: "class Foo { fun bar() { baz() } }", expect: { name: "Foo", kind: "class" } }, // kotlin ~4.1MB
  { file: "a.sh", code: "hello() {\n  do_thing\n}", expect: { name: "hello", kind: "function" } }, // bash ~1.4MB
  { file: "a.scala", code: "class Foo { def bar() = baz() }", expect: { name: "Foo", kind: "class" } }, // ~0.2MB
];

export const PART4: LangCase[] = [
  { file: "a.cs", code: "class Foo { void Bar() { Baz(); } }", expect: { name: "Foo", kind: "class" } }, // c_sharp ~4.0MB
  { file: "a.rs", code: "struct Foo {}\nfn hello() -> i32 { do_thing() }", expect: { name: "Foo", kind: "struct" } }, // ~0.8MB
  { file: "a.zig", code: "fn hello() i32 { return doThing(); }", expect: { name: "hello", kind: "function" } }, // ~0.7MB
  { file: "a.sol", code: "contract Foo {\n  function bar() public {}\n}", expect: { name: "Foo", kind: "class" } }, // ~0.4MB
];

/** Every part, for the budget guard. Order matches the file numbering. */
export const PARTS: readonly LangCase[][] = [PART1, PART2, PART3, PART4];
