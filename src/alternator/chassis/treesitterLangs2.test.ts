/**
 * treesitterLangs2.test.ts — broad language coverage, part 2 of 4 (see langCases.ts).
 */
import { test } from "node:test";
import { checkLang, PART2 } from "./langCases.js";

for (const c of PART2) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}
