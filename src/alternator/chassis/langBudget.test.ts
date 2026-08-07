/**
 * langBudget.test.ts — the language parts stay balanced by GRAMMAR BYTES.
 *
 * This is the mechanical guard described in langCases.ts. Grammars differ in size by
 * more than a hundredfold, so a split balanced by case COUNT tells you nothing about
 * what a test process actually loads. A prose note would drift; this weighs the real
 * files, so adding a heavy grammar fails here with a clear message.
 *
 * This guard does NOT prevent the suite's out-of-memory crash. That one is the size
 * of the `ocaml` grammar itself, addressed by heap headroom and the sequential
 * `test:lang` phase in package.json. See langCases.ts for the measurements.
 *
 * Loads no grammar — it only stats them, so it is cheap and safe to run anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { PARTS, PART_BUDGET_BYTES, type LangCase } from "./langCases.js";
import { GRAMMAR_DIR, grammarFileFor } from "./treesitter.js";

/** Grammar bytes a part loads, counting each distinct grammar once (several
 *  extensions can share one, so summing per case would overstate it). */
function partBytes(cases: readonly LangCase[]): number {
  const grammars = new Set<string>();
  for (const c of cases) {
    const g = grammarFileFor(c.file);
    assert.ok(g, `${c.file} has no grammar — the case list and LANGS disagree`);
    grammars.add(g!);
  }
  let total = 0;
  for (const g of grammars) total += statSync(join(GRAMMAR_DIR, g)).size;
  return total;
}

test("no language part exceeds the grammar byte budget", () => {
  PARTS.forEach((part, i) => {
    const bytes = partBytes(part);
    assert.ok(
      bytes <= PART_BUDGET_BYTES,
      `part ${i + 1} loads ${(bytes / 1e6).toFixed(1)}MB of grammars, over the ` +
        `${(PART_BUDGET_BYTES / 1e6).toFixed(1)}MB budget. Move a language to a lighter ` +
        `part rather than raising the budget.`,
    );
  });
});

test("the parts are actually balanced, not just under the cap", () => {
  // A split that is under budget but lopsided is the state this guard exists to
  // catch early: the heaviest part is what decides whether the suite flakes.
  const sizes = PARTS.map(partBytes);
  const heaviest = Math.max(...sizes);
  const lightest = Math.min(...sizes);
  assert.ok(
    heaviest <= lightest * 2,
    `parts are lopsided: heaviest ${(heaviest / 1e6).toFixed(1)}MB vs lightest ` +
      `${(lightest / 1e6).toFixed(1)}MB (${sizes.map((s) => (s / 1e6).toFixed(1)).join(", ")}MB)`,
  );
});

test("every case's grammar file really exists on disk", () => {
  // Guards the case list against a typo'd extension, which would otherwise show up
  // as a confusing extraction failure inside checkLang.
  for (const part of PARTS) {
    for (const c of part) {
      const g = grammarFileFor(c.file)!;
      assert.ok(statSync(join(GRAMMAR_DIR, g)).size > 0, `${g} missing for ${c.file}`);
    }
  }
});
