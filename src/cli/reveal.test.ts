/**
 * reveal.test.ts — the pure tool-reveal policy: prefer showing a row already
 * resolved; only fall back to a running header once a slow tool outlives the grace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planToolReveal } from "./reveal.js";

const GRACE = 350;

test("a resolved tool reveals complete, in one step — regardless of timing", () => {
  assert.equal(planToolReveal(true, 0, GRACE, false), "resolved");
  assert.equal(planToolReveal(true, 9999, GRACE, false), "resolved");
  assert.equal(planToolReveal(true, 0, GRACE, true), "resolved"); // even while flushing
});

test("a just-started tool with no result yet is held, not shown as a bare header", () => {
  assert.equal(planToolReveal(false, 0, GRACE, false), "hold");
  assert.equal(planToolReveal(false, GRACE - 1, GRACE, false), "hold");
});

test("a tool still running past the grace window falls back to a running header", () => {
  assert.equal(planToolReveal(false, GRACE, GRACE, false), "running");
  assert.equal(planToolReveal(false, GRACE + 500, GRACE, false), "running");
});

test("flushing (Esc) never holds — an unresolved tool shows its running header at once", () => {
  assert.equal(planToolReveal(false, 0, GRACE, true), "running");
});
