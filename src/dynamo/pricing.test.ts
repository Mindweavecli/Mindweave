/**
 * pricing.test.ts — the task usage/cost summary (pure).
 *
 * Verifies the fix for the "every task looks like ~700K" problem: ctx is the LAST
 * call's prompt (not a sum), hit/miss/output are summed, the cache split drives a
 * cache-aware cost, and a provider that omits the split is costed safely as fresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTask, priceFor, formatTokens, formatCost, taskLimitReason } from "./pricing.js";
import type { Usage } from "./deepseek.js";

const u = (p: number, c: number, hit: number, miss: number): Usage => ({
  promptTokens: p,
  completionTokens: c,
  totalTokens: p + c,
  cacheHitTokens: hit,
  cacheMissTokens: miss,
});

test("summarizeTask uses the LAST prompt as ctx and SUMS the billed tokens", () => {
  // Three steps, context growing as the conversation is re-sent each call.
  const s = summarizeTask(
    [u(40_000, 1000, 30_000, 10_000), u(45_000, 1000, 42_000, 3000), u(50_000, 2000, 47_000, 3000)],
    "deepseek-v4-flash",
  )!;
  assert.equal(s.ctxTokens, 50_000); // the LAST call's prompt, not 135_000
  assert.equal(s.totalTokens, 41_000 + 46_000 + 52_000); // real throughput, summed
  assert.equal(s.cacheHitTokens, 119_000);
  assert.equal(s.cacheMissTokens, 16_000);
  assert.equal(s.outputTokens, 4000);
  assert.equal(s.cachePct, Math.round((119_000 / 135_000) * 100)); // 88%
});

test("summarizeTask costs cache hits ~10x cheaper than misses (DeepSeek default)", () => {
  const s = summarizeTask([u(1_000_000, 0, 1_000_000, 0)], "deepseek-v4-flash")!;
  // 1M cache-hit tokens at $0.014/M.
  assert.ok(Math.abs(s.costUsd - 0.014) < 1e-9, `got ${s.costUsd}`);
  const miss = summarizeTask([u(1_000_000, 0, 0, 1_000_000)], "deepseek-v4-flash")!;
  assert.ok(Math.abs(miss.costUsd - 0.14) < 1e-9, `got ${miss.costUsd}`);
});

test("summarizeTask treats an unreported cache split as fresh input (safe over-estimate)", () => {
  const s = summarizeTask([u(1_000_000, 0, 0, 0)], "deepseek-v4-flash")!;
  assert.equal(s.cacheMissTokens, 1_000_000);
  assert.equal(s.cachePct, 0);
  assert.ok(Math.abs(s.costUsd - 0.14) < 1e-9);
});

test("summarizeTask returns null for an empty task", () => {
  assert.equal(summarizeTask([]), null);
});

test("priceFor honors a MINDWEAVE_PRICE override, else falls back to the table/default", () => {
  const prev = process.env.MINDWEAVE_PRICE;
  try {
    delete process.env.MINDWEAVE_PRICE;
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
    assert.deepEqual(priceFor("unknown-model"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
    process.env.MINDWEAVE_PRICE = "1,2,3";
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 1, cacheMiss: 2, output: 3 });
    process.env.MINDWEAVE_PRICE = "garbage";
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
  } finally {
    if (prev === undefined) delete process.env.MINDWEAVE_PRICE;
    else process.env.MINDWEAVE_PRICE = prev;
  }
});

test("taskLimitReason fires on cost or time, and is disabled at 0", () => {
  const usage = summarizeTask([u(1_000_000, 0, 0, 1_000_000)], "deepseek-v4-flash")!; // $0.14
  // Cost ceiling
  assert.match(taskLimitReason(usage, 0, { maxUsd: 0.1, maxSeconds: 0 })!, /cost ceiling/);
  assert.equal(taskLimitReason(usage, 0, { maxUsd: 0.5, maxSeconds: 0 }), null);
  // Time ceiling
  assert.match(taskLimitReason(null, 20_000, { maxUsd: 0, maxSeconds: 10 })!, /time ceiling/);
  assert.equal(taskLimitReason(null, 5_000, { maxUsd: 0, maxSeconds: 10 }), null);
  // Both disabled
  assert.equal(taskLimitReason(usage, 999_000, { maxUsd: 0, maxSeconds: 0 }), null);
});

test("formatTokens and formatCost render compactly", () => {
  assert.equal(formatTokens(540), "540");
  assert.equal(formatTokens(8123), "8.1K");
  assert.equal(formatTokens(56_000), "56K");
  assert.equal(formatCost(0.0005), "<$0.001");
  assert.equal(formatCost(0.018), "~$0.018");
  assert.equal(formatCost(1.42), "~$1.42");
});
