/**
 * treesitterLangs3.test.ts — broad language coverage, part 3 of 3 (see langCases.ts).
 */
import { test } from "node:test";
import { checkLang, type LangCase } from "./langCases.js";

const CASES: LangCase[] = [
  { file: "a.scala", code: "class Foo { def bar() = baz() }", expect: { name: "Foo", kind: "class" } },
  { file: "a.sh", code: "hello() {\n  do_thing\n}", expect: { name: "hello", kind: "function" } },
  { file: "a.ml", code: "let hello x = do_thing x", expect: { name: "hello", kind: "function" } },
  { file: "a.zig", code: "fn hello() i32 { return doThing(); }", expect: { name: "hello", kind: "function" } },
  { file: "a.kt", code: "class Foo { fun bar() { baz() } }", expect: { name: "Foo", kind: "class" } },
];

for (const c of CASES) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}
