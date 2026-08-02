import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas } from "./registry.js";

test("toolSchemas advertises every tool by default", () => {
  assert.equal(toolSchemas().length, TOOLS.length);
});

test("the editing tools route to each other, so the model can pick correctly", () => {
  // Which tool to reach for is decided entirely by these descriptions — the model has
  // nothing else to go on. When they don't cross-reference, the observed cost is real:
  // repeated single edits where one batched call belonged, or a whole-file rewrite to
  // change three lines. Each tool has to name the neighbour that beats it, so the
  // routing survives someone rewording one of them in isolation.
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));

  // edit_file is the default, and points UP to multi_edit for repeated edits.
  assert.match(byName.edit_file!, /DEFAULT/);
  assert.match(byName.edit_file!, /multi_edit/);

  // multi_edit states its scope, and points DOWN to edit_file for a single change.
  assert.match(byName.multi_edit!, /ONE file/);
  assert.match(byName.multi_edit!, /edit_file/);

  // write_file is the last resort, and points at both targeted tools.
  assert.match(byName.write_file!, /edit_file/);
  assert.match(byName.write_file!, /multi_edit/);

  // replace_symbol_body owns whole definitions and defers for changes inside one.
  assert.match(byName.replace_symbol_body!, /edit_file|multi_edit/);
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
