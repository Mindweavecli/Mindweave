/**
 * langCases.ts — shared checker for the broad-language tests.
 *
 * Loading every grammar wasm in one process exhausts V8's heap, and Node's test
 * runner isolates each test FILE in its own process — so the language cases are
 * split across two test files, each exercising this checker on a subset. Keeping
 * the assertion here means both files verify identically.
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
