/**
 * promptAssembly.test.ts — where each governance block lands in the request.
 *
 * Rules moved from the cached system PREFIX to the volatile BOUNDARY (salience:
 * a long session can't bury them). Forbidden paths/commands and skills stay in the
 * prefix (forbidden is enforced mechanically; skills are a reference catalog).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { volatileContext, staticSystemPrompt } from "./engine.js";

const gov = (over: Partial<{ rules: string; forbidden: string; forbiddenCommands: string; skills: string }>) => ({
  rules: "",
  forbidden: "",
  forbiddenCommands: "",
  skills: "",
  ...over,
});

test("standing rules render at the volatile boundary, with binding framing", () => {
  const ctx = volatileContext("- Use pnpm, never npm", "", "", "", false, "");
  assert.match(ctx, /<rules>/);
  assert.match(ctx, /Use pnpm, never npm/);
  assert.match(ctx, /BINDING/);
});

test("no rules → no rules block in the boundary", () => {
  const ctx = volatileContext("", "", "", "", false, "");
  assert.equal(ctx.includes("<rules>"), false);
});

test("rules are NOT in the cached system prefix anymore (moved to the boundary)", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ rules: "- Use pnpm, never npm" }), "");
  assert.equal(sys.includes("<rules>"), false);
  assert.equal(sys.includes("Use pnpm, never npm"), false);
});

test("forbidden commands DO stay in the cached system prefix", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ forbiddenCommands: "- tauri dev" }), "");
  assert.match(sys, /<forbidden_commands>/);
  assert.match(sys, /tauri dev/);
});

test("forbidden paths still stay in the cached system prefix", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ forbidden: "- src/legacy" }), "");
  assert.match(sys, /<forbidden>/);
  assert.match(sys, /src\/legacy/);
});
