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

test("DeepSeek anchors to its ~128K sharp window (not 1M storage)", () => {
  assert.equal(sharpContextWindow("deepseek-v4-flash"), 128_000);
  assert.equal(sharpContextWindow("deepseek-v4-pro"), 128_000);
});

test("the bars scale with the window, so a longer model gets more room", () => {
  assert.ok(autoBarFor(200_000) > autoBarFor(128_000));
  assert.ok(microBarFor(200_000) > microBarFor(128_000));
});

test("thresholds are ordered micro < auto < window, with real headroom", () => {
  for (const win of [128_000, 200_000, 1_000_000]) {
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
  assert.equal(sharpContextWindow("some-new-model"), 128_000);
  assert.ok(autoCompactThreshold("some-new-model") > 0);
  assert.ok(microCompactThreshold("some-new-model") > 0);
});
