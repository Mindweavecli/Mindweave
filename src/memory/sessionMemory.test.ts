/**
 * sessionMemory.test.ts — the pure parts of session memory: the update trigger (token
 * growth gated), the injected block, and the budget bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldUpdateSessionMemory,
  renderSessionMemory,
  boundSessionMemory,
  SESSION_MEMORY_TEMPLATE,
} from "./sessionMemory.js";
import { estimateTokens } from "./compaction.js";

test("no update until the session warms past the init bar", () => {
  assert.equal(shouldUpdateSessionMemory(5_000, 0, false), false);
  assert.equal(shouldUpdateSessionMemory(10_000, 0, false), true);
});

test("after init, updates only once growth crosses the update threshold", () => {
  assert.equal(shouldUpdateSessionMemory(15_000, 10_000, true), false, "5K growth is not enough");
  assert.equal(shouldUpdateSessionMemory(25_000, 10_000, true), true, "15K growth triggers");
});

test("renderSessionMemory wraps notes in a tagged block, and is empty when blank", () => {
  assert.equal(renderSessionMemory("   "), "");
  const block = renderSessionMemory("# Current State\nbuilding the sidebar");
  assert.match(block, /<session_memory>/);
  assert.match(block, /building the sidebar/);
  assert.match(block, /<\/session_memory>/);
});

test("boundSessionMemory leaves within-budget notes alone but trims oversize ones", () => {
  const small = "# Title\nx";
  assert.equal(boundSessionMemory(small, 10_000), small);
  const huge = "y".repeat(100_000);
  const bounded = boundSessionMemory(huge, 1_000);
  assert.ok(estimateTokens(bounded) <= 1_100, "trimmed near the cap");
  assert.match(bounded, /truncated/);
});

test("the template holds all the expected sections", () => {
  for (const s of [
    "# Session Title",
    "# Current State",
    "# Task specification",
    "# Files and Functions",
    "# Workflow",
    "# Errors & Corrections",
    "# Codebase and System Documentation",
    "# Learnings",
    "# Key results",
    "# Worklog",
  ]) {
    assert.ok(SESSION_MEMORY_TEMPLATE.includes(s), `template has ${s}`);
  }
});
