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
import { basePrompt } from "./prompt.js";

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

// ── Its own past sessions ─────────────────────────────────────────────────────
//
// Transcripts are saved but nothing loads them, so unless the prompt says so the
// model believes it has never worked here — and says so to the user while a full
// transcript of that exact work sits unread on disk.

test("with no prior sessions, nothing is claimed", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 0);
  assert.ok(!/worked in this project before/.test(sys));
});

test("prior sessions are announced, with the count and how to reach them", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 2);
  assert.match(sys, /worked in this project before/);
  assert.match(sys, /2 earlier sessions/);
  assert.match(sys, /\/continue/);
});

test("a single prior session reads as singular, not '1 sessions'", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 1);
  assert.match(sys, /1 earlier session of yours/);
  assert.ok(!/1 earlier sessions/.test(sys));
});

test("it is told it cannot read those sessions from here, and not to substitute another tool's", () => {
  // The failure this guards against: going hunting through a different agent's
  // saved conversations and presenting them as its own recollection.
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 3);
  assert.match(sys, /cannot see what was said/);
  assert.match(sys, /never present another tool's saved conversations as your own/);
});

// ── The shared prompt stays provider-neutral ──────────────────────────────────
//
// These phrases were written to correct one model's habit and lived in the prompt
// every provider reads. One of them was demonstrably not working on the very model
// it targeted, while still costing every other model tokens and attention. They
// were removed; these assertions stop them drifting back in.
// See BOUNDARY.md for when a behavioral line belongs in core at all.

test("no model-specific behavioral patches in the shared prompt", () => {
  const sys = basePrompt("bash");
  const banned: [RegExp, string][] = [
    [/repeat a summary you have already given/i, "repeat-summary rule (written for one model, didn't work on it)"],
    [/blindly retry the identical action/i, "retry rule (duplicates the REPEAT_FAIL_LIMIT breaker in engine.ts)"],
  ];
  for (const [pattern, why] of banned) {
    assert.ok(!pattern.test(sys), `shared prompt reintroduced the ${why}`);
  }
});

test("the prompt does not promise a capability only some providers document", () => {
  // Parallel tool calling is GA and documented for one provider, undocumented for
  // another. Encourage batching (a cost argument, true everywhere) rather than
  // asserting the models can all do it.
  const sys = basePrompt("bash");
  assert.ok(!/can be called several at a time/i.test(sys), "reasserted parallel tool calls as a guarantee");
  assert.match(sys, /issue them in one turn/i, "lost the batching guidance entirely");
});

test("the harness facts that every provider needs are still present", () => {
  // The counterweight: this must not become an excuse to hollow out the prompt.
  const sys = basePrompt("bash");
  assert.match(sys, /verify it actually works/i, "lost the verify-before-done rule");
  assert.match(sys, /Report what happened honestly/i, "lost the honest-reporting rule");
  assert.match(sys, /Do what was asked, then stop/i, "lost scope discipline (cross-model evidenced)");
});
