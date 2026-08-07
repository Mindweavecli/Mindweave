/**
 * gitignore.test.ts — the Node walk honours .gitignore the way ripgrep does.
 *
 * The defect this pins: search has two engines, and only ripgrep respected
 * .gitignore, so results depended on whether `rg` was installed while both tool
 * descriptions stated the behaviour as universal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitignore, isIgnored, type IgnoreLayer } from "./gitignore.js";
import { walkFiles } from "./walk.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ignore-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await fs.mkdir(join(abs, ".."), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

async function walked(dir: string): Promise<string[]> {
  const { files } = await walkFiles(dir, 1000);
  return files.map((f) => f.rel).sort();
}

// ── the rule language ─────────────────────────────────────────────────────────

test("a bare name matches at any depth; a slashed rule is anchored", () => {
  const layer: IgnoreLayer = { base: "/p", rules: parseGitignore("secret.txt\n//top.txt\n") };
  const hit = (rel: string) => isIgnored([{ layer, rel }], false);
  assert.equal(hit("secret.txt"), true);
  assert.equal(hit("deep/nested/secret.txt"), true, "bare name matches at depth");

  const anchored: IgnoreLayer = { base: "/p", rules: parseGitignore("/top.txt\n") };
  const anchoredHit = (rel: string) => isIgnored([{ layer: anchored, rel }], false);
  assert.equal(anchoredHit("top.txt"), true);
  assert.equal(anchoredHit("sub/top.txt"), false, "leading slash anchors to the root");
});

test("negation re-includes, and the LAST matching rule wins", () => {
  const layer: IgnoreLayer = { base: "/p", rules: parseGitignore("*.log\n!keep.log\n") };
  assert.equal(isIgnored([{ layer, rel: "a.log" }], false), true);
  assert.equal(isIgnored([{ layer, rel: "keep.log" }], false), false);

  // Order matters: reversing the rules must flip the outcome.
  const reversed: IgnoreLayer = { base: "/p", rules: parseGitignore("!keep.log\n*.log\n") };
  assert.equal(isIgnored([{ layer: reversed, rel: "keep.log" }], false), true);
});

test("a trailing slash restricts a rule to directories", () => {
  const layer: IgnoreLayer = { base: "/p", rules: parseGitignore("build/\n") };
  assert.equal(isIgnored([{ layer, rel: "build" }], true), true, "matches the directory");
  assert.equal(isIgnored([{ layer, rel: "build" }], false), false, "not a file of the same name");
});

test("comments and blank lines are skipped, not treated as patterns", () => {
  const rules = parseGitignore("# a comment\n\n   \nreal.txt\n");
  assert.equal(rules.length, 1);
});

test("an unsupported character class hides nothing rather than guessing", () => {
  // Deliberate: over-hiding makes a file look like it does not exist, which is the
  // failure mode worth avoiding. See the module header.
  const layer: IgnoreLayer = { base: "/p", rules: parseGitignore("[abc].txt\n") };
  assert.equal(isIgnored([{ layer, rel: "a.txt" }], false), false);
});

test("a deeper .gitignore overrides a shallower one", () => {
  const root: IgnoreLayer = { base: "/p", rules: parseGitignore("*.log\n") };
  const nested: IgnoreLayer = { base: "/p/sub", rules: parseGitignore("!*.log\n") };
  const decision = isIgnored(
    [
      { layer: root, rel: "sub/a.log" },
      { layer: nested, rel: "a.log" },
    ],
    false,
  );
  assert.equal(decision, false, "the nested file re-includes it");
});

// ── the walk actually applying them ───────────────────────────────────────────

test("walkFiles skips gitignored files, matching ripgrep", async () => {
  const dir = await project({
    ".gitignore": "*.log\ngenerated/\n",
    "src/app.ts": "x",
    "debug.log": "noise",
    "generated/big.ts": "noise",
  });
  const rels = await walked(dir);
  assert.ok(rels.includes("src/app.ts"));
  assert.ok(!rels.includes("debug.log"), "gitignored file listed");
  assert.ok(!rels.some((r) => r.startsWith("generated/")), "gitignored directory descended");
});

test("an ignored directory is not descended into at all", async () => {
  const dir = await project({
    ".gitignore": "vendor/\n",
    "vendor/deep/nested/thing.ts": "x",
    "keep.ts": "x",
  });
  // .gitignore itself is a normal tracked file, so it is listed — git does not
  // ignore it, and neither should we.
  assert.deepEqual(await walked(dir), [".gitignore", "keep.ts"]);
});

test("a nested .gitignore applies to its own subtree", async () => {
  const dir = await project({
    "pkg/.gitignore": "*.tmp\n",
    "pkg/a.tmp": "x",
    "top.tmp": "x",
    "pkg/keep.ts": "x",
  });
  const rels = await walked(dir);
  assert.ok(!rels.includes("pkg/a.tmp"), "nested rule not applied");
  assert.ok(rels.includes("top.tmp"), "nested rule leaked upward");
  assert.ok(rels.includes("pkg/keep.ts"));
});

test("gitignore: false sees everything, for walks that must not filter", async () => {
  const dir = await project({ ".gitignore": "*.log\n", "debug.log": "x", "a.ts": "x" });
  const { files } = await walkFiles(dir, 1000, { gitignore: false });
  assert.ok(files.map((f) => f.rel).includes("debug.log"));
});

test("a project with no .gitignore is unaffected", async () => {
  const dir = await project({ "a.ts": "x", "b/c.ts": "x" });
  assert.deepEqual(await walked(dir), ["a.ts", "b/c.ts"]);
});
