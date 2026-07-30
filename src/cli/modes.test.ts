import { test } from "node:test";
import assert from "node:assert/strict";
import { MODES, DEFAULT_MODE, modeById, nextMode } from "./modes.js";

test("default mode is an enabled, non-read-only mode", () => {
  const d = modeById(DEFAULT_MODE);
  assert.equal(d.enabled, true);
  assert.equal(d.readOnly, false);
});

test("modeById falls back to the default for an unknown id", () => {
  // @ts-expect-error — deliberately passing a bad id
  assert.equal(modeById("nope").id, DEFAULT_MODE);
});

test("shift-tab cycles Lightning → Architect → Sentinel → Lightning", () => {
  assert.equal(nextMode("lightning"), "architect");
  assert.equal(nextMode("architect"), "sentinel");
  assert.equal(nextMode("sentinel"), "lightning");
});

test("the cycle never lands on a disabled mode", () => {
  const enabledIds = new Set(MODES.filter((m) => m.enabled).map((m) => m.id));
  let cur = DEFAULT_MODE;
  for (let i = 0; i < 10; i++) {
    cur = nextMode(cur);
    assert.ok(enabledIds.has(cur), `${cur} should be enabled`);
  }
});

test("a forced out-of-rotation mode still cycles back to an enabled mode", () => {
  // @ts-expect-error — an id not in the rotation should recover to an enabled mode.
  assert.ok(MODES.find((m) => m.id === nextMode("bogus"))?.enabled);
});

test("Sentinel is the guarded (ask-before-acting) mode and is enabled", () => {
  const s = modeById("sentinel");
  assert.equal(s.enabled, true);
  assert.equal(s.guarded, true);
  assert.equal(s.readOnly, false);
});

test("Lightning and Architect are not guarded", () => {
  assert.equal(modeById("lightning").guarded, false);
  assert.equal(modeById("architect").guarded, false);
});

test("every mode has an icon, a color, and a descriptor", () => {
  for (const m of MODES) {
    assert.ok(m.icon.length >= 1, `${m.id} needs an icon`);
    assert.ok(m.color.length >= 1, `${m.id} needs a color`);
    assert.ok(m.descriptor.length >= 1, `${m.id} needs a descriptor`);
  }
});

test("Architect is the read-only mode", () => {
  assert.equal(modeById("architect").readOnly, true);
});
