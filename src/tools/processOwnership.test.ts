/**
 * processOwnership.test.ts — the rules that keep a killed process actually dead, on
 * a platform this test cannot run on.
 *
 * A SOURCE SCAN, and deliberately so. Killing a process tree on POSIX needs the child
 * to lead its own process group, and whether that happened cannot be observed from
 * Windows — which is exactly how the bug this guards survived: `killTree` was skipped
 * entirely off Windows, and every test that might have noticed was itself
 * Windows-gated. The failure is also silent on the affected platform. Mindweave exits,
 * the user gets their prompt back, and an orphaned language server or MCP server keeps
 * running with a port held. Nothing errors, so nothing tells you.
 *
 * Structure is the only thing checkable from here, so structure is what gets pinned.
 * The same approach engine.test.ts and providerNeutrality.test.ts take for their own
 * invisible failures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const killTreeSource = read("./killTree.ts");
const runCommandSource = read("./runCommand.ts");
const stdioSource = read("../mcp/transport/stdio.ts");
const lspSource = read("../alternator/chassis/lsp.ts");

test("spawnManaged puts POSIX children in their own process group", () => {
  // This single line is what makes `process.kill(-pid)` mean anything. Without it the
  // negative pid names a group that does not exist, the kill throws ESRCH, the catch
  // swallows it, and the tree survives.
  assert.match(
    killTreeSource,
    /detached: IS_WINDOWS \? false : \(options\.detached \?\? true\)/,
    "the POSIX process group must be established at spawn time",
  );
});

test("POSIX kills escalate rather than going straight to SIGKILL", () => {
  const body = killTreeSource.match(/export function killTree\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "killTree not found — did it move?");
  assert.match(body, /SIGTERM/, "a process deserves the chance to shut down cleanly");
  assert.match(body, /SIGKILL/, "…and must still die if it ignores that");
});

test("every long-lived child is spawned through spawnManaged", () => {
  // A process spawned with bare `spawn` cannot be tree-killed on POSIX no matter what
  // the kill path does, so the two have to be introduced together.
  for (const [name, src] of [
    ["run_command", runCommandSource],
    ["the MCP stdio transport", stdioSource],
    ["the language-server host", lspSource],
  ] as const) {
    assert.match(src, /spawnManaged\(/, `${name} must spawn through spawnManaged`);
  }
});

test("the tree kill is NOT gated on being shelled", () => {
  // `shelled` is Windows-only. Gating on it meant macOS and Linux never tree-killed at
  // all: only the direct child was signalled and its children were orphaned. This is
  // the exact line that was wrong in two files at once.
  assert.doesNotMatch(stdioSource, /if \(this\.shelled\) \(sync \? killTreeSync : killTree\)/);
  assert.doesNotMatch(lspSource, /if \(shelled\) killTreeSync/);
  assert.match(stdioSource, /\(sync \? killTreeSync : killTree\)\(this\.proc\.pid\)/);
});

test("the shell is resolved, never hardcoded to /bin/sh", () => {
  // `/bin/sh` is dash on Debian and Ubuntu, where ordinary bash syntax is a syntax
  // error. The resolved shell is also what the model is TOLD it is running in, so a
  // hardcoded value here becomes a false claim in the prompt.
  assert.doesNotMatch(runCommandSource, /bin: "\/bin\/sh"/, "the shell must be resolved, not assumed");
  assert.match(runCommandSource, /bin: posixShell\(\)\.bin/);
});

test("the shell label the prompt shows is computed, so it cannot go stale", () => {
  const body = runCommandSource.match(/export function commandShellLabel\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "commandShellLabel not found");
  assert.match(body, /posixShell\(\)\.isBash/, "the label must reflect what actually resolved");
});
