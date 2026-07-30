/**
 * multiroot.test.ts — the workspace spanning more than one root.
 *
 * The contract: paths stay collision-proof via `label/relative`, that string
 * round-trips back to the right root, search covers every root, and add/remove
 * roots behaves. This is the "nothing collides" guarantee for /include.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { relativize, resolvePath, searchUnits, anchorOf } from "./paths.js";
import { addRoot, removeRoot } from "./workspace.js";
import { grepTool } from "./grep.js";
import type { ToolContext } from "./types.js";

function ctx(cwd: string, roots: string[]): ToolContext {
  return { cwd, roots, reads: new Map(), todos: [] };
}

async function twoRoots(fn: (a: string, b: string) => Promise<void>) {
  const a = await mkdtemp(join(tmpdir(), "mindweave-rootA-"));
  const b = await mkdtemp(join(tmpdir(), "mindweave-rootB-"));
  try {
    await fn(a, b);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
}

test("relativize labels by root; resolvePath round-trips the label", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a, b]);
    const labelA = basename(a);
    const labelB = basename(b);

    assert.equal(relativize(c, join(a, "src", "x.ts")), `${labelA}/src/x.ts`);
    assert.equal(relativize(c, join(b, "y.ts")), `${labelB}/y.ts`);
    // The labeled string resolves back to the exact file.
    assert.equal(resolvePath(c, `${labelB}/y.ts`), join(b, "y.ts"));
    assert.equal(resolvePath(c, `${labelA}/src/x.ts`), join(a, "src", "x.ts"));
  });
});

test("single root is unchanged (no labels)", async () => {
  await twoRoots(async (a) => {
    const c = ctx(a, [a]);
    assert.equal(relativize(c, join(a, "x.ts")), "x.ts"); // plain relative, no label
  });
});

test("searchUnits sweeps all roots when no path, one when given", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a, b]);
    assert.equal(searchUnits(c, undefined).length, 2);
    const one = searchUnits(c, `${basename(b)}`);
    assert.equal(one.length, 1);
    assert.equal(one[0]!.root, b);
  });
});

test("grep spans both roots and labels every hit", async () => {
  await twoRoots(async (a, b) => {
    await fs.writeFile(join(a, "a.txt"), "the needle is here\n");
    await fs.mkdir(join(b, "sub"));
    await fs.writeFile(join(b, "sub", "b.txt"), "another needle there\n");

    const c = ctx(a, [a, b]);
    const res = await grepTool.execute({ pattern: "needle", output_mode: "files_with_matches" }, c);
    assert.ok(!res.isError);
    assert.ok(res.output.includes(`${basename(a)}/a.txt`), res.output);
    assert.ok(res.output.includes(`${basename(b)}/sub/b.txt`), res.output);
  });
});

test("addRoot / removeRoot manage the live workspace", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a]);
    const added = await addRoot(c, b);
    assert.equal(added.label, basename(b));
    assert.deepEqual(c.roots, [a, b]);

    // Idempotent.
    assert.equal((await addRoot(c, b)).already, true);

    const removed = removeRoot(c, basename(b));
    assert.equal(removed.removed, basename(b));
    assert.deepEqual(c.roots, [a]);

    // Can't remove the primary.
    assert.ok(removeRoot(c, basename(a)).error);
  });
});

// ── Fix B: file-path resolution is anchored to the root, not the shell cwd ──

test("relative paths resolve against the fixed anchor even after cd moved cwd", () => {
  // The bug: a build did `cd src-tauri`, moving ctx.cwd into the subdir; a later
  // edit_file("App.css") then resolved to <root>/src-tauri/App.css and failed
  // "file not found". With the anchor decoupling it must resolve to <root>/App.css.
  const root = resolve("/project");
  const movedCwd = join(root, "src-tauri"); // where a `cd` left the shell
  const c: ToolContext = { cwd: movedCwd, roots: [root], reads: new Map(), todos: [] };

  assert.equal(anchorOf(c), root);
  assert.equal(resolvePath(c, "App.css"), resolve(root, "App.css"));
  assert.equal(resolvePath(c, "src/main.rs"), resolve(root, "src/main.rs"));
});

test("single-root: an absent roots list falls back to cwd as the anchor", () => {
  const here = resolve("/here");
  const c: ToolContext = { cwd: here, reads: new Map(), todos: [] };
  assert.equal(anchorOf(c), here);
  assert.equal(resolvePath(c, "a.txt"), resolve(here, "a.txt"));
});

test("relativize shows the shell cwd as a clean subpath of the anchor", () => {
  const root = resolve("/project");
  const c: ToolContext = { cwd: join(root, "src-tauri"), roots: [root], reads: new Map(), todos: [] };
  // run_command's status line does relativize(ctx, ctx.cwd) — should read "src-tauri".
  assert.equal(relativize(c, c.cwd), "src-tauri");
  assert.equal(relativize(c, join(root, "App.css")), "App.css");
});
