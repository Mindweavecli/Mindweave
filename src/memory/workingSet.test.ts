/**
 * workingSet.test.ts — the pure working-set core + an end-to-end buildWorkingSet over
 * a real temp dir (freshness + big-file localization), without a model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadRecord, ToolContext } from "../tools/types.js";
import {
  selectActiveFiles,
  numberedRange,
  renderWorkingFiles,
  buildWorkingSet,
  type PreparedFile,
} from "./workingSet.js";

// ── selection (LRU) ──────────────────────────────────────────────────────────────

test("selectActiveFiles returns the most-recently-touched files, capped", () => {
  const reads = new Map<string, ReadRecord>([
    ["/p/a.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }],
    ["/p/b.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 3 }],
    ["/p/c.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 2 }],
  ]);
  const active = selectActiveFiles(reads, 2);
  assert.deepEqual(active.map((a) => a.path), ["/p/b.ts", "/p/c.ts"]); // by recency, capped at 2
});

// ── line numbering ───────────────────────────────────────────────────────────────

test("numberedRange numbers an inclusive, clamped slice", () => {
  const lines = ["a", "b", "c", "d"];
  assert.equal(numberedRange(lines, 2, 3), "2\tb\n3\tc");
  assert.equal(numberedRange(lines, 3, 99), "3\tc\n4\td"); // clamped
});

// ── budgeting + render ───────────────────────────────────────────────────────────

test("renderWorkingFiles keeps within budget and reports full paths", () => {
  const files: PreparedFile[] = [
    { path: "/p/a.ts", block: "AAA", tokens: 100, full: true, shown: [{ start: 1, end: 9 }] },
    { path: "/p/b.ts", block: "BBB", tokens: 100, full: false, shown: [{ start: 4, end: 8 }] },
    { path: "/p/c.ts", block: "CCC", tokens: 100, full: true, shown: [{ start: 1, end: 9 }] },
  ];
  const { text, fullPaths } = renderWorkingFiles(files, 250); // fits 2, evicts 1
  assert.match(text, /AAA/);
  assert.match(text, /BBB/);
  assert.doesNotMatch(text, /CCC/);
  assert.match(text, /1 less-recent file omitted/);
  assert.ok(fullPaths.has("/p/a.ts"));
  assert.ok(!fullPaths.has("/p/b.ts")); // localized, not full
});

test("renderWorkingFiles always keeps at least the first file (over budget)", () => {
  const files: PreparedFile[] = [{ path: "/p/big.ts", block: "X", tokens: 9999, full: true, shown: [{ start: 1, end: 1 }] }];
  const { text } = renderWorkingFiles(files, 100);
  assert.match(text, /big\.ts|X/);
});

// ── end-to-end buildWorkingSet ───────────────────────────────────────────────────

function ctxWith(dir: string, reads: Map<string, ReadRecord>): ToolContext {
  return { cwd: dir, reads, todos: [] };
}

test("buildWorkingSet injects a small file's current content and marks it full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-"));
  const p = join(dir, "a.ts");
  await fs.writeFile(p, "export const x = 1;\nexport const y = 2;\n");
  const reads = new Map<string, ReadRecord>([[p, { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }]]);
  const ctx = ctxWith(dir, reads);

  const { text, fullPaths } = await buildWorkingSet(ctx);
  assert.match(text, /working on/);
  assert.match(text, /export const x = 1/); // current content, line-numbered
  assert.ok(fullPaths.has(p), "small file is included in full");
});

test("buildWorkingSet keeps ALL touched files (no fixed count cap), not just the most recent few", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-many-"));
  const reads = new Map<string, ReadRecord>();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, `f${i}.ts`);
    await fs.writeFile(p, `export const v${i} = ${i};\n`);
    reads.set(p, { mtimeMs: 0, size: 0, full: true, touchedAt: i + 1 });
  }
  const ctx = ctxWith(dir, reads);

  const { text, fullPaths } = await buildWorkingSet(ctx);
  for (let i = 0; i < 6; i++) {
    assert.match(text, new RegExp(`v${i} = ${i}`), `file f${i} should be present (would fail at a 3-file cap)`);
  }
  assert.equal(fullPaths.size, 6, "all small files fit and are shown in full");
});

test("buildWorkingSet reflects the LATEST content (no staleness) and skips vanished files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws2-"));
  const p = join(dir, "a.ts");
  await fs.writeFile(p, "old();\n");
  const reads = new Map<string, ReadRecord>([
    [p, { mtimeMs: 0, size: 0, full: true, touchedAt: 2 }],
    [join(dir, "gone.ts"), { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }],
  ]);
  const ctx = ctxWith(dir, reads);

  await fs.writeFile(p, "brandNew();\n"); // change on disk after the read was recorded
  const { text } = await buildWorkingSet(ctx);
  assert.match(text, /brandNew/); // fresh from disk
  assert.doesNotMatch(text, /old\(\)/);
  assert.doesNotMatch(text, /gone\.ts/); // missing file skipped, never throws
});
