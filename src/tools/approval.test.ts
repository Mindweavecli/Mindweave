/**
 * approval.test.ts — the forbidden-path lift: ask the human, then proceed / refuse /
 * defer, and fall back to a hard refusal when there's no channel to ask.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestForbiddenLift } from "./approval.js";
import type { ToolContext } from "./types.js";

function ctxWith(approve?: (q: string, o: string[]) => Promise<string>): ToolContext {
  return {
    cwd: "/proj",
    reads: new Map(),
    todos: [],
    governance: { rules: [], skills: [], forbidden: { patterns: ["secret.txt", "other"], root: "/proj" } },
    requestApproval: approve,
  };
}

test("no approval channel → hard refusal (fail-closed)", async () => {
  const ctx = ctxWith(undefined);
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "it is protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /protected/);
  // Deny-list untouched.
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["secret.txt", "other"]);
});

test("Allow → proceeds (null) and lifts the pattern for the session", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[0]!); // first option = allow
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.equal(res, null); // proceed
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["other"]); // lifted just this one
});

test("Deny → keeps it protected", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[1]!); // second option = deny
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /declined to lift/);
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["secret.txt", "other"]);
});

test("Defer → hands control back to the user", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[2]!); // third option = defer
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /will tell you how to proceed/);
});
