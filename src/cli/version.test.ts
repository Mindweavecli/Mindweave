/**
 * version.test.ts — the banner must show the REAL version.
 *
 * This exists because it didn't. The banner read "v0.0.1" while package.json said
 * 1.1.2, through three releases, in front of the user at every launch. Nothing could
 * catch it: a hardcoded string type-checks and never throws. So the guard is a test
 * that compares the two, plus a scan that stops the literal coming back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { appVersion, versionLabel } from "./version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

test("the version shown is the version in package.json", () => {
  assert.equal(appVersion(), pkg.version);
  assert.match(versionLabel(), new RegExp(`\\(v${pkg.version.replace(/\./g, "\\.")}\\)`));
});

test("no component hardcodes a version string", () => {
  const app = readFileSync(join(root, "src", "cli", "App.tsx"), "utf8");
  assert.doesNotMatch(
    app,
    /agent \(v\d/,
    "the banner version is a literal again — it will drift on the next release; use versionLabel()",
  );
});
