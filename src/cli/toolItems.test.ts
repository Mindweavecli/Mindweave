/**
 * toolItems.test.ts — item labels and the collapse of repeated adjacent calls (the
 * "collide the same silent thing" rule that kills shell_output poll-spam).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLabel, collapseAdjacent } from "./toolItems.js";
import type { ToolGroupItem } from "./transcript.js";

function item(p: Partial<ToolGroupItem>): ToolGroupItem {
  return { toolId: Math.random().toString(36).slice(2), name: "Read", status: "ok", ...p };
}

test("a running item reads present-tense; resolved shows its result", () => {
  assert.equal(itemLabel(item({ name: "Read", arg: "x.ts", status: "running" })), "Reading x.ts");
  assert.equal(itemLabel(item({ name: "Shell", status: "running" })), "Checking");
  assert.equal(itemLabel(item({ status: "ok", note: "read x.ts (12 lines)" })), "Read x.ts (12 lines)");
});

test("consecutive identical items collapse into one row with a ×N count", () => {
  const polls = Array.from({ length: 9 }, () => item({ name: "Shell", status: "ok", note: "shell #1 (running)" }));
  const rows = collapseAdjacent(polls);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.count, 9);
  assert.equal(rows[0]!.label, "Shell #1 (running)");
});

test("distinct calls are NOT merged — only adjacent identical ones", () => {
  const rows = collapseAdjacent([
    item({ note: "read a.ts (10 lines)" }),
    item({ note: "read b.ts (20 lines)" }),
    item({ note: "read a.ts (10 lines)" }),
  ]);
  assert.equal(rows.length, 3, "same label but not adjacent → three rows");
});

test("a run broken by a different call restarts the count", () => {
  const rows = collapseAdjacent([
    item({ note: "shell #1 (running)" }),
    item({ note: "shell #1 (running)" }),
    item({ note: "read x.ts (5 lines)" }),
    item({ note: "shell #1 (running)" }),
  ]);
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 1]);
});

test("an error anywhere in a collapsed run is remembered", () => {
  const rows = collapseAdjacent([
    item({ note: "shell #1 (running)", status: "ok" }),
    item({ note: "shell #1 (running)", status: "error" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.anyError, true);
});
