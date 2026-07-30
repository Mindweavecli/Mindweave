/**
 * lsp.test.ts — the precision tier against a real language server.
 *
 * Exercises the bundled typescript-language-server end-to-end: launch, initialize,
 * workspace/symbol, and textDocument/references. Generous timeout (first launch is
 * slow). If the server can't run in this environment the assertions surface it
 * rather than silently passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager } from "./lsp.js";
import { CodeChassis } from "./index.js";

async function tsProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-lsp-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper(): number { return 1; }\n");
  await fs.writeFile(join(dir, "src/main.ts"), "import { helper } from './util';\nexport function run() { return helper(); }\n");
  return dir;
}

test("LspManager returns compiler-accurate symbols and references", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "src/util.ts"));
    lsp.noteFile(join(dir, "src/main.ts"));

    const syms = await lsp.symbols("helper");
    assert.ok(syms.length >= 1, "workspace/symbol should find helper");
    const def = syms.find((s) => s.file.endsWith("util.ts"))!;
    assert.ok(def, "helper should be defined in util.ts");
    assert.equal(def.kind, "function");

    const refs = await lsp.references(def.file, def.line, def.character);
    assert.ok(refs.some((r) => r.file.endsWith("main.ts")), "helper should be referenced from main.ts");
  } finally {
    await lsp.dispose();
  }
});

test("LspManager resolves Python symbols via bundled pyright", { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-py-"));
  await fs.writeFile(join(dir, "util.py"), "def helper():\n    return 1\n");
  await fs.writeFile(join(dir, "main.py"), "from util import helper\n\ndef run():\n    return helper()\n");
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "util.py"));
    lsp.noteFile(join(dir, "main.py"));
    const syms = await lsp.symbols("helper");
    assert.ok(syms.some((s) => s.file.endsWith("util.py")), "pyright should find helper in util.py");
  } finally {
    await lsp.dispose();
  }
});

test("CodeChassis with LSP returns resolved confidence", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const ch = new CodeChassis(dir, { lsp: true });
  try {
    await ch.build();
    const def = await ch.definition("helper");
    assert.ok(def.symbols.length >= 1);
    assert.equal(def.confidence, "resolved");
    assert.match(def.symbols[0].file, /util\.ts$/);
  } finally {
    await ch.dispose();
  }
});
