/**
 * model.test.ts — the model/reasoning selection: level tables, clamping, persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL_CONFIG,
  loadModelConfig,
  saveModelConfig,
  thinkLabel,
  thinkLevels,
  withModel,
} from "./model.js";

test("Flash offers 2 reasoning levels, Pro offers 3", () => {
  assert.equal(thinkLevels("deepseek-v4-flash").length, 2);
  assert.equal(thinkLevels("deepseek-v4-pro").length, 3);
});

test("thinkLabel reflects the config", () => {
  assert.equal(thinkLabel({ model: "deepseek-v4-flash", thinking: false, effort: "high" }), "Standard");
  assert.equal(thinkLabel({ model: "deepseek-v4-flash", thinking: true, effort: "high" }), "Reasoning");
  assert.equal(thinkLabel({ model: "deepseek-v4-pro", thinking: true, effort: "max" }), "Maximum");
});

test("withModel clamps Pro-Maximum down to Flash-high (Flash has no maximum tier)", () => {
  const proMax = { model: "deepseek-v4-pro", thinking: true, effort: "max" } as const;
  const onFlash = withModel(proMax, "deepseek-v4-flash");
  assert.equal(onFlash.model, "deepseek-v4-flash");
  assert.equal(onFlash.thinking, true);
  assert.equal(onFlash.effort, "high"); // clamped
});

test("save → load roundtrips the config; missing file falls back to default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mindweave-model-"));
  try {
    // Nothing saved → default.
    const fresh = await loadModelConfig(dir);
    assert.deepEqual(fresh, DEFAULT_MODEL_CONFIG);

    const cfg = { model: "deepseek-v4-pro", thinking: true, effort: "max" } as const;
    await saveModelConfig(dir, cfg);
    assert.deepEqual(await loadModelConfig(dir), cfg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
