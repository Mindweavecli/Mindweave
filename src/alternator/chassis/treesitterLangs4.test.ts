/**
 * treesitterLangs4.test.ts — broad language coverage, part 4 of 4 (see langCases.ts).
 */
import { test } from "node:test";
import { checkLang, PART4 } from "./langCases.js";

for (const c of PART4) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}
