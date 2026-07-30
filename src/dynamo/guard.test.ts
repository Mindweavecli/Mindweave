import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUARD_OPTIONS,
  GUARD_REFUSAL,
  describeCall,
  guardQuestion,
  interpretGuardChoice,
} from "./guard.js";

test("interpretGuardChoice maps each option to its action", () => {
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[0]), "proceed");
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[1]), "allow-all");
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[2]), "refuse");
});

test("interpretGuardChoice fails safe on cancel / unknown answers", () => {
  assert.equal(interpretGuardChoice(undefined), "refuse"); // Esc / no channel
  assert.equal(interpretGuardChoice(""), "refuse");
  assert.equal(interpretGuardChoice("whatever"), "refuse");
});

test("describeCall names the file for edit/write tools", () => {
  assert.equal(describeCall("edit_file", { path: "src/app.ts" }), "edit_file — src/app.ts");
  assert.equal(describeCall("write_file", { path: "a/b.ts" }), "write_file — a/b.ts");
  assert.equal(describeCall("replace_symbol_body", { path: "m.ts", name: "greet" }), "replace_symbol_body — m.ts");
});

test("describeCall shows the command for run_command, clipped", () => {
  assert.equal(describeCall("run_command", { command: "npm test" }), "run_command — npm test");
  const long = describeCall("run_command", { command: "x".repeat(200) });
  assert.ok(long.length < 120, "long commands are clipped");
  assert.ok(long.endsWith("…"));
});

test("describeCall shows the task for spawn_subagent", () => {
  assert.equal(describeCall("spawn_subagent", { task: "find call sites" }), "spawn_subagent — find call sites");
});

test("describeCall degrades gracefully for unknown tools", () => {
  assert.equal(describeCall("some_external_tool", { path: "/tmp/x" }), "some_external_tool — /tmp/x");
  assert.equal(describeCall("weird_tool", {}), "weird_tool");
});

test("guardQuestion includes the described call and there are exactly 3 options", () => {
  const q = guardQuestion("run_command", { command: "rm -rf build" });
  assert.match(q, /Sentinel/);
  assert.match(q, /rm -rf build/);
  assert.equal(GUARD_OPTIONS.length, 3);
  assert.ok(GUARD_REFUSAL.length > 0);
});
