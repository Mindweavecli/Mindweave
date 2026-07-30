/**
 * treesitterLangs2.test.ts — broad language coverage, part 2 of 4 (see langCases.ts).
 */
import { test } from "node:test";
import { checkLang, type LangCase } from "./langCases.js";

const CASES: LangCase[] = [
  { file: "a.lua", code: "function hello()\n  return doThing()\nend", expect: { name: "hello", kind: "function" } },
  { file: "a.sol", code: "contract Foo {\n  function bar() public {}\n}", expect: { name: "Foo", kind: "class" } },
  { file: "a.c", code: "int hello() { return do_thing(); }", expect: { name: "hello", kind: "function" } },
  { file: "a.cs", code: "class Foo { void Bar() { Baz(); } }", expect: { name: "Foo", kind: "class" } },
];

for (const c of CASES) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}
