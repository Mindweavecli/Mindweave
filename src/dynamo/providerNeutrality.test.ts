/**
 * providerNeutrality.test.ts — core must not name a specific model.
 *
 * The architectural rule (BOUNDARY.md): core never knows which model is running.
 * Only `drivers/<provider>/` may name a provider's models, endpoints, or wire
 * fields.
 *
 * This is enforced here rather than trusted, because it has already been broken
 * twice and neither break failed loudly:
 *   - `/model`'s autocomplete read "choose the model (DeepSeek V4 Flash / Pro)"
 *     long after a second provider shipped four models. Simply false, and shown to
 *     the user every session.
 *   - the `/think` overlay fell back to a hardcoded `"deepseek-v4-flash"`.
 *
 * Both type-checked, both passed every test, and neither would ever throw. A
 * source-level invariant is the only thing that catches this class.
 *
 * Scope note: MODEL IDS are banned outright, since core has no legitimate reason to
 * name one. Provider BRAND names are not — `tools/guard.ts` names other coding
 * tools on purpose (to avoid reading their private data), which is correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Model-id shapes. Every real model id carries a version digit
 * (`deepseek-v4-flash`, `claude-sonnet-5`, `gpt-4o`), and requiring one is what
 * keeps this from firing on a product name like "Claude Code" — which core is
 * allowed to mention, because the agent-data guard names other tools on purpose.
 */
const MODEL_ID =
  /\b(deepseek-[a-z0-9.-]*\d[a-z0-9.-]*|claude-[a-z0-9.-]*\d[a-z0-9.-]*|gpt-\d[a-z0-9.-]*|gemini-[a-z0-9.-]*\d[a-z0-9.-]*)\b/i;

/** Directories under src/ that MAY name models. */
const ALLOWED = ["drivers"];

/** Walk core source files (everything except the driver folders). */
function coreFiles(dir: string, rel = ""): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) {
      if (ALLOWED.includes(name)) continue;
      out.push(...coreFiles(abs, r));
    } else if (/\.tsx?$/.test(name)) {
      out.push({ path: abs, rel: r });
    }
  }
  return out;
}

test("the detector actually catches the strings that shipped broken", () => {
  // Proves this test can fail. Without this, a regex typo would make every
  // assertion below vacuously pass and the guard would be worthless.
  assert.ok(MODEL_ID.test('description: "choose the model (DeepSeek V4 Flash / Pro)"') === false);
  assert.ok(MODEL_ID.test('const model = cur?.modelConfig.model ?? "deepseek-v4-flash";'));
  assert.ok(MODEL_ID.test('thinkLevels("claude-sonnet-5")'));
  assert.ok(MODEL_ID.test("gpt-4o"));
  // Ordinary core code must not trip it.
  assert.ok(!MODEL_ID.test("const model = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;"));
  assert.ok(!MODEL_ID.test('note(`model → ${modelLabel(s.modelConfig.model)}`)'));
  // A tool's PRODUCT name is not a model id — the agent-data guard names these
  // deliberately, so matching them here would be a false positive.
  assert.ok(!MODEL_ID.test("* This is the Claude-Code split: the model sees the bytes"));
  assert.ok(!MODEL_ID.test('{ test: /(^|\\/)\\.claude(\\/|$)/i, what: "Claude Code" },'));
});

test("no core source file names a concrete model id", () => {
  const offenders: string[] = [];
  for (const { path, rel } of coreFiles(SRC)) {
    // Tests legitimately use model ids as fixtures — they are exercising the
    // driver registry through core's API, not hardcoding a provider into behavior.
    if (rel.includes(".test.")) continue;
    const text = readFileSync(path, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(MODEL_ID);
      if (m) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `core must not name a model id — move it to drivers/, or read it from the registry:\n${offenders.join("\n")}`,
  );
});
