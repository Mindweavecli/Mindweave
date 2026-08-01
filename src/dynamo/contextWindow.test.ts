/**
 * contextWindow.test.ts — model-anchored thresholds: micro < auto < window, and a
 * longer-window model automatically gets a higher bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sharpContextWindow,
  autoCompactThreshold,
  microCompactThreshold,
  autoBarFor,
  microBarFor,
} from "./contextWindow.js";

test("DeepSeek anchors to its sharp window (not its 1M storage cap)", () => {
  assert.equal(sharpContextWindow("deepseek-v4-pro"), 256_000);
  assert.equal(sharpContextWindow("deepseek-v4-flash"), 192_000);
  // Both stay well under the 1M storage limit: the anchor is where multi-needle
  // retrieval stays reliable, not where the model stops accepting tokens.
  assert.ok(sharpContextWindow("deepseek-v4-pro") < 1_000_000);
});

test("Flash gets its own window rather than inheriting Pro's curve", () => {
  // No published multi-needle data exists for Flash, so it anchors lower on
  // purpose. If these ever collapse to one number, the split was lost by accident.
  assert.notEqual(sharpContextWindow("deepseek-v4-flash"), sharpContextWindow("deepseek-v4-pro"));
  assert.ok(sharpContextWindow("deepseek-v4-flash") < sharpContextWindow("deepseek-v4-pro"));
});

test("the bars scale with the window, so a longer model gets more room", () => {
  assert.ok(autoBarFor(256_000) > autoBarFor(128_000));
  assert.ok(microBarFor(256_000) > microBarFor(128_000));
  // The split is visible downstream, not just in the raw window.
  assert.ok(microCompactThreshold("deepseek-v4-pro") > microCompactThreshold("deepseek-v4-flash"));
});

test("thresholds are ordered micro < auto < window, with real headroom", () => {
  for (const win of [128_000, 192_000, 256_000, 1_000_000]) {
    const auto = autoBarFor(win);
    const micro = microBarFor(win);
    assert.ok(micro < auto, `${win}: micro < auto`);
    assert.ok(auto < win, `${win}: auto below the window`);
    assert.ok(win - auto >= 30_000, `${win}: reserves room for summary + buffer`);
  }
});

test("a tiny window still leaves a usable floor rather than going negative", () => {
  assert.equal(autoBarFor(8_000), 20_000);
});

test("an unknown model falls back to a safe default rather than throwing", () => {
  // Unknown ids resolve through the default driver and land on the CONSERVATIVE
  // side of the split, never the higher Pro window.
  assert.equal(sharpContextWindow("some-new-model"), 192_000);
  assert.ok(autoCompactThreshold("some-new-model") > 0);
  assert.ok(microCompactThreshold("some-new-model") > 0);
});
