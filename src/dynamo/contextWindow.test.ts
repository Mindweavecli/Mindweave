/**
 * contextWindow.test.ts — model-anchored thresholds: micro < auto < window, and a
 * stronger/longer model automatically gets a higher bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharpContextWindow, autoCompactThreshold, microCompactThreshold } from "./contextWindow.js";

test("DeepSeek anchors to its ~128K sharp window (not 1M storage)", () => {
  assert.equal(sharpContextWindow("deepseek-v4-flash"), 128_000);
  assert.equal(sharpContextWindow("deepseek-v4-pro"), 128_000);
});

test("a longer-context model family gets a larger window automatically", () => {
  assert.ok(sharpContextWindow("claude-opus-4-8") > sharpContextWindow("deepseek-v4-flash"));
});

test("thresholds are ordered micro < auto < window, with real headroom", () => {
  for (const model of ["deepseek-v4-flash", "claude-opus-4-8", "gpt-5"]) {
    const win = sharpContextWindow(model);
    const auto = autoCompactThreshold(model);
    const micro = microCompactThreshold(model);
    assert.ok(micro < auto, `${model}: micro < auto`);
    assert.ok(auto < win, `${model}: auto below the window`);
    assert.ok(win - auto >= 30_000, `${model}: reserves room for summary + buffer`);
  }
});

test("an unknown model falls back to a safe default rather than throwing", () => {
  assert.equal(sharpContextWindow("some-new-model"), 128_000);
  assert.ok(autoCompactThreshold("some-new-model") > 0);
});
