/**
 * treesitterLangs3.test.ts — broad language coverage, part 3 of 4 (see langCases.ts).
 */
import { test } from "node:test";
import { checkLang, PART3 } from "./langCases.js";

for (const c of PART3) {
  test(`${c.file}: extracts ${c.expect.kind} ${c.expect.name}`, () => checkLang(c));
}
