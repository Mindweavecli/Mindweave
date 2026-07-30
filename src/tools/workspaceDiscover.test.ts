/**
 * workspaceDiscover.test.ts — finding the rest of the project: monorepo members
 * first, sibling projects as the fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRelatedRoots } from "./workspaceDiscover.js";

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mindweave-ws-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("package.json workspaces (packages/*) expand to member folders", async () => {
  await withDir(async (root) => {
    await fs.writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await fs.mkdir(join(root, "packages", "api"), { recursive: true });
    await fs.mkdir(join(root, "packages", "web"), { recursive: true });

    const found = await discoverRelatedRoots(root, [root]);
    const names = found.map((f) => f.path.split(/[/\\]/).pop()).sort();
    assert.deepEqual(names, ["api", "web"]);
    assert.ok(found.every((f) => f.reason === "workspace member"));
  });
});

test("pnpm-workspace.yaml packages are discovered", async () => {
  await withDir(async (root) => {
    await fs.writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    await fs.mkdir(join(root, "apps", "admin"), { recursive: true });
    const found = await discoverRelatedRoots(root, [root]);
    assert.deepEqual(found.map((f) => f.path.split(/[/\\]/).pop()), ["admin"]);
  });
});

test("falls back to sibling projects when there's no monorepo config", async () => {
  await withDir(async (parent) => {
    const main = join(parent, "frontend");
    const sibling = join(parent, "backend");
    await fs.mkdir(main, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(join(sibling, "go.mod"), "module backend\n"); // looks like a project
    await fs.mkdir(join(parent, "notes")); // not a project — should be ignored

    const found = await discoverRelatedRoots(main, [main]);
    assert.deepEqual(found.map((f) => f.path.split(/[/\\]/).pop()), ["backend"]);
    assert.equal(found[0]!.reason, "sibling project");
  });
});

test("already-included roots are not suggested again", async () => {
  await withDir(async (root) => {
    await fs.writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await fs.mkdir(join(root, "packages", "api"), { recursive: true });
    const api = join(root, "packages", "api");
    const found = await discoverRelatedRoots(root, [root, api]);
    assert.equal(found.length, 0);
  });
});
