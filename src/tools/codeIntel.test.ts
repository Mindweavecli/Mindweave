/**
 * codeIntel.test.ts — the chassis-backed tools (outline/definition/references/relevant).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outlineTool, definitionTool, referencesTool, relevantTool } from "./codeIntel.js";
import { CodeChassis } from "../alternator/chassis/index.js";
import type { ToolContext } from "./types.js";

async function projectCtx(): Promise<ToolContext> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ci-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper() { return 1; }\n");
  await fs.writeFile(
    join(dir, "src/main.ts"),
    "import { helper } from './util';\nfunction run() { return helper(); }\nrun();\n",
  );
  const chassis = new CodeChassis(dir, { lsp: false }); // tree-sitter tier only
  await chassis.build();
  return { cwd: dir, reads: new Map(), chassis, todos: [] };
}

test("outline tool shows a file's symbols", async () => {
  const ctx = await projectCtx();
  const r = await outlineTool.execute({ path: "src/main.ts" }, ctx);
  assert.match(r.output, /run/);
  assert.match(r.output, /src\/main\.ts/);
});

test("definition tool locates a symbol with a confidence caveat", async () => {
  const ctx = await projectCtx();
  const r = await definitionTool.execute({ name: "helper" }, ctx);
  assert.match(r.output, /src\/util\.ts:1/);
  assert.match(r.output, /name-level match/); // tree-sitter tier
});

test("references tool finds use sites", async () => {
  const ctx = await projectCtx();
  const r = await referencesTool.execute({ name: "helper" }, ctx);
  assert.match(r.output, /src\/main\.ts:/);
});

test("relevant tool returns a ranked map", async () => {
  const ctx = await projectCtx();
  const r = await relevantTool.execute({ path: "src/main.ts" }, ctx);
  assert.ok(r.output.length > 0);
  assert.doesNotMatch(r.output, /isn't available/);
});

test("tools degrade gracefully when no chassis is present", async () => {
  const ctx: ToolContext = { cwd: "/p", reads: new Map(), todos: [] };
  const r = await definitionTool.execute({ name: "x" }, ctx);
  assert.match(r.output, /isn't available/);
});
