/**
 * providerSwitch.test.ts — the ordering that keeps /provider recoverable.
 *
 * A source scan, like engine.test.ts's compaction guard, because the property is an
 * ORDER of operations inside a React handler rather than a value a unit test can
 * observe. It exists because of a real bug: `applyProvider` saved the new model to
 * disk BEFORE checking whether that provider had a key, so choosing a provider you
 * had no key for wrote an unusable config, and the project then reopened straight
 * into the key prompt on every launch with no way back from inside the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");

function body(fn: string): string {
  const match = source.match(new RegExp(`async function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `${fn} not found — did it get renamed?`);
  return match![1]!;
}

test("applyProvider checks for the key before it saves anything", () => {
  const fn = body("applyProvider");
  const check = fn.indexOf("missingKeyFor");
  const save = fn.indexOf("saveModelConfig");
  assert.ok(check >= 0, "the key check is gone — an unusable provider can be selected");
  // A save reached before the check is the original bug: it persists a provider that
  // cannot answer, and the config outlives the session that made it.
  assert.ok(save < 0 || check < save, "the key must be checked before the switch is persisted");
});

test("applyProvider hands the pending switch to the key prompt", () => {
  // Without carrying `pending`, the prompt has nothing to complete on success and
  // nothing to abandon on Esc — which is what made it a dead end.
  assert.match(body("applyProvider"), /pending:/, "the prompt must know which switch it would unlock");
});

test("the key prompt is escapable exactly when there is something to go back to", () => {
  // Esc is gated on `pending`: a first-run gate has no session behind it, so it stays
  // blocking; a gate reached by choosing a provider must let you out.
  assert.match(source, /isActive: keyNeed\?\.pending !== undefined/, "Esc must be active only for a pending switch");
});

test("a saved config whose provider lost its key falls back instead of trapping", () => {
  assert.match(source, /usableFallback\(/, "startup must be able to recover a config it cannot run");
});
