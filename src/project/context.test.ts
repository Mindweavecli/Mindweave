/**
 * context.test.ts — the project orientation snapshot.
 *
 * Builds a throwaway project on disk and asserts the snapshot orients correctly:
 * environment is always present, signals detect the manifest, the tree is
 * budgeted and skips ignored dirs, and rendering produces the tagged blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProjectContext, renderProjectContext } from "./context.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mindweave-ctx-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo-app", scripts: { build: "tsc", test: "node" }, devDependencies: { typescript: "5" } }),
  );
  writeFileSync(join(root, "README.md"), "# Demo App\n\nA tiny demo for orientation.");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  // A dir that must be ignored, with a file inside that must NOT show up.
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "junk.js"), "module.exports = {};\n");
  // A planning/notes doc in a notes folder — the kind of file that must always surface.
  mkdirSync(join(root, "notez"));
  writeFileSync(
    join(root, "notez", "feature-ideas.md"),
    "# Feature ideas\n\nInspired by Obsidian, Notion, Scrivener.\n",
  );
  writeFileSync(join(root, "TODO.md"), "# Things to do\n\n- ship it\n");
  // Legal boilerplate and README must NOT be listed as notes docs.
  writeFileSync(join(root, "LICENSE"), "MIT License\n\nCopyright...\n");
  return root;
}

test("environment is always captured", async () => {
  const pc = await collectProjectContext(fixture());
  assert.equal(typeof pc.environment.cwd, "string");
  assert.ok(pc.environment.platform.length > 0);
  assert.match(pc.environment.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pc.environment.runtime.startsWith("Node"));
});

test("signals detect name, scripts, and TypeScript", async () => {
  const pc = await collectProjectContext(fixture());
  assert.equal(pc.signals.name, "demo-app");
  assert.ok(pc.signals.kinds.includes("Node/TypeScript"));
  assert.deepEqual(pc.signals.scripts.sort(), ["build", "test"]);
  assert.ok(pc.signals.manifests.includes("package.json"));
});

test("tree includes real files and skips ignored dirs", async () => {
  const pc = await collectProjectContext(fixture());
  const flat = pc.tree.lines.join("\n");
  assert.ok(flat.includes("src/"), "should list the src dir");
  assert.ok(flat.includes("index.ts"), "should list a source file");
  assert.ok(!flat.includes("node_modules"), "must skip ignored dirs");
  assert.ok(!flat.includes("junk.js"), "must not descend into ignored dirs");
});

test("readme excerpt is captured", async () => {
  const pc = await collectProjectContext(fixture());
  assert.ok(pc.readme && pc.readme.includes("Demo App"));
});

test("notable docs are surfaced with a descriptor, README/MINDWEAVE/legal excluded", async () => {
  const pc = await collectProjectContext(fixture());
  const paths = pc.docs.map((d) => d.path);
  assert.ok(paths.includes("notez/feature-ideas.md"), "should surface the notes doc in a subfolder");
  assert.ok(paths.includes("TODO.md"), "should surface a root TODO");
  assert.ok(!paths.some((p) => p.toLowerCase().startsWith("readme")), "README is shown separately, not as a note");
  assert.ok(!paths.includes("LICENSE"), "legal boilerplate must be excluded");
  const feature = pc.docs.find((d) => d.path === "notez/feature-ideas.md");
  assert.equal(feature?.desc, "Feature ideas", "descriptor comes from the first heading");
});

test("render produces the tagged blocks the prompt expects", async () => {
  const text = renderProjectContext(await collectProjectContext(fixture()));
  assert.ok(text.includes("<environment>"));
  assert.ok(text.includes("</environment>"));
  assert.ok(text.includes("<project_overview>"));
  assert.ok(text.includes("Project: demo-app"));
  assert.ok(text.includes("Docs & notes"), "the docs section renders");
  assert.ok(text.includes("notez/feature-ideas.md — Feature ideas"), "doc line renders path + descriptor");
});

test("missing directory degrades to environment-only, never throws", async () => {
  const pc = await collectProjectContext(join(tmpdir(), "mindweave-does-not-exist-" + Date.now()));
  assert.equal(pc.tree.lines.length, 0);
  assert.equal(pc.signals.kinds.length, 0);
  // Rendering still yields the environment block.
  assert.ok(renderProjectContext(pc).includes("<environment>"));
});
