/**
 * posixShell.test.ts — picking the shell, and warning when the one we got is too
 * minimal for what the model wrote.
 *
 * Pure by construction: `pickShell` takes its filesystem probe as an argument, so
 * these run identically on Windows, macOS and Linux. That matters — this logic is
 * ABOUT POSIX but is developed on Windows, and a test that only ran on the target
 * platform would be exactly the gap this whole change exists to close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickShell, shellMismatchNote } from "./posixShell.js";

const BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"];

/** A fake filesystem: only these paths are executable. */
const only = (...present: string[]) => (p: string) => present.includes(p);

// ── choosing the shell ────────────────────────────────────────────────────────

test("bash is preferred when it is there", () => {
  const shell = pickShell(BASH_CANDIDATES, [], only("/bin/bash"));
  assert.equal(shell.bin, "/bin/bash");
  assert.equal(shell.isBash, true);
});

test("candidates are tried in order, so the most standard location wins", () => {
  const shell = pickShell(BASH_CANDIDATES, [], only("/bin/bash", "/usr/bin/bash"));
  assert.equal(shell.bin, "/bin/bash");
});

test("a bash only on PATH is still found (NixOS, Homebrew, unusual layouts)", () => {
  const shell = pickShell(BASH_CANDIDATES, ["/opt/weird/bin"], only("/opt/weird/bin/bash"));
  assert.equal(shell.bin, "/opt/weird/bin/bash");
  assert.equal(shell.isBash, true);
});

test("with no bash anywhere it falls back to /bin/sh and SAYS it is not bash", () => {
  // The flag is what drives the warning. Reporting sh as bash would be worse than
  // the original bug: the model would be told its dialect is safe when it is not.
  const shell = pickShell(BASH_CANDIDATES, ["/usr/bin"], only("/bin/sh"));
  assert.equal(shell.bin, "/bin/sh");
  assert.equal(shell.isBash, false);
});

test("a bash that exists but is not executable does not count", () => {
  // existsSync would accept this and then fail at spawn time.
  const shell = pickShell(BASH_CANDIDATES, [], () => false);
  assert.equal(shell.isBash, false);
});

// ── the mismatch warning ──────────────────────────────────────────────────────

const SH = { bin: "/bin/sh", isBash: false };
const BASH = { bin: "/bin/bash", isBash: true };

test("on bash, nothing is ever flagged", () => {
  // The common path by a wide margin: bash exists, so no dialect problem can arise.
  assert.equal(shellMismatchNote("if [[ -f x ]]; then source y; fi", BASH), null);
});

test("on a minimal sh, bash-only syntax is named along with the fix", () => {
  const note = shellMismatchNote("if [[ -f x ]]; then echo hi; fi", SH);
  assert.ok(note);
  assert.match(note, /\[\[ \]\] tests/);
  assert.match(note, /use \[ \] instead/);
  assert.match(note, /no bash/);
});

test("the constructs that actually break dash are caught", () => {
  for (const cmd of [
    "source ./env.sh",
    "diff <(sort a) <(sort b)",
    "function build() { make; }",
    "echo ${arr[0]}",
    "echo $RANDOM",
    "for i in {1..5}; do echo $i; done",
    "make &> log.txt",
    "echo -e 'a\\nb'",
  ]) {
    assert.ok(shellMismatchNote(cmd, SH), `should have flagged: ${cmd}`);
  }
});

test("portable commands are left alone, even on a minimal sh", () => {
  // A false positive nags the model about a command that would have worked, so the
  // linter has to stay conservative to be worth having.
  for (const cmd of [
    "ls -la",
    "if [ -f x ]; then . ./y; fi",
    "grep -r foo src | head -20",
    "npm run build && npm test",
    "cd src; make",
    "printf 'a\\nb\\n'",
  ]) {
    assert.equal(shellMismatchNote(cmd, SH), null, `should NOT have flagged: ${cmd}`);
  }
});

test("a bash-ism inside a quoted string is not flagged", () => {
  assert.equal(shellMismatchNote(`echo "use [[ ]] in bash"`, SH), null);
  assert.equal(shellMismatchNote(`git commit -m 'add source maps'`, SH), null);
});
