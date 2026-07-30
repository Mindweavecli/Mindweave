/**
 * servers.test.ts — the language-server registry (deterministic; no spawning).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { languageIdFor, serverFor, specForLanguage } from "./servers.js";

test("languageIdFor maps a broad set of extensions", () => {
  assert.equal(languageIdFor("/p/a.ts"), "typescript");
  assert.equal(languageIdFor("/p/a.tsx"), "typescriptreact");
  assert.equal(languageIdFor("/p/a.py"), "python");
  assert.equal(languageIdFor("/p/a.go"), "go");
  assert.equal(languageIdFor("/p/a.rs"), "rust");
  assert.equal(languageIdFor("/p/a.cpp"), "cpp");
  assert.equal(languageIdFor("/p/a.rb"), "ruby");
  assert.equal(languageIdFor("/p/a.kt"), "kotlin");
  assert.equal(languageIdFor("/p/a.unknownext"), undefined);
});

test("bundled servers resolve out-of-the-box (TS + Python)", () => {
  const ts = specForLanguage("typescript");
  assert.ok(ts, "typescript-language-server should resolve (bundled)");
  assert.match(ts!.args.join(" "), /cli\.mjs/);
  const py = specForLanguage("python");
  assert.ok(py, "pyright should resolve (bundled)");
  assert.match(py!.args.join(" "), /langserver/);
});

test("unknown / uninstalled languages degrade to no server", () => {
  assert.equal(specForLanguage("cobol"), null); // not in registry
  assert.equal(serverFor("/p/a.xyz"), null); // unknown extension
});
