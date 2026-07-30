import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas } from "./registry.js";

test("toolSchemas advertises every tool by default", () => {
  assert.equal(toolSchemas().length, TOOLS.length);
});

test("plan mode advertises only read-only tools", () => {
  const names = new Set(toolSchemas({ planMode: true }).map((t) => t.function.name));
  const mutating = TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
  // No mutating tool is offered…
  for (const m of mutating) assert.ok(!names.has(m), `${m} should be withheld in plan mode`);
  // …and edit/write/run are exactly the kind that must be gone.
  for (const m of ["write_file", "edit_file", "run_command"]) assert.ok(!names.has(m));
  // Read-only discovery stays available.
  assert.ok(names.has("read_file"));
});
