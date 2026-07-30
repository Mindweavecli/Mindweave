/**
 * shellLint.test.ts — the PowerShell bash-ism advisory (pure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { powershellLintReason, powershellParseError, powershellReservedAssignmentReason } from "./shellLint.js";

test("flags genuinely-broken bash-isms in PowerShell", () => {
  assert.match(powershellLintReason("grep -r foo .")!, /Select-String/);
  assert.match(powershellLintReason("npm test 2>/dev/null")!, /\$null/);
  assert.match(powershellLintReason("cd src && npm run build")!, /&&/);
  assert.match(powershellLintReason("sed -i 's/a/b/' f")!, /replace|Get-Content/);
  assert.match(powershellLintReason("cat f | head -20")!, /Get-Content -TotalCount/);
  assert.match(powershellLintReason("export FOO=1")!, /\$env:/);
});

test("does NOT flag valid PowerShell (aliases and cmdlets are fine)", () => {
  // ls, cat, rm, cp, mv, echo, pwd, sort are real PowerShell aliases.
  assert.equal(powershellLintReason("ls -Recurse"), null);
  assert.equal(powershellLintReason("cat file.txt"), null);
  assert.equal(powershellLintReason("rm -Force foo.txt"), null);
  assert.equal(powershellLintReason("Get-ChildItem -Recurse | Select-String foo"), null);
  assert.equal(powershellLintReason("npm run build; npm test"), null);
  assert.equal(powershellLintReason("git log --oneline -n 5"), null);
});

test("ignores bash-isms inside quoted strings", () => {
  assert.equal(powershellLintReason(`Write-Output "a && b"`), null);
  assert.equal(powershellLintReason(`Write-Output 'pipe to /dev/null'`), null);
  assert.equal(powershellLintReason(`git commit -m "use grep for this"`), null);
});

// ── powershellParseError: the pre-execution gate (ONLY hard parse errors) ─────────

test("powershellParseError blocks ONLY && / || (guaranteed parse errors)", () => {
  assert.match(powershellParseError("cd src && npm test")!, /won't run/);
  assert.match(powershellParseError("npm test || echo fail")!, /shell:'cmd'/);
});

test("powershellParseError does NOT block things that actually run", () => {
  // These execute (and may even work) — they stay advisory, never pre-blocked.
  assert.equal(powershellParseError("npm test 2>/dev/null"), null);
  assert.equal(powershellParseError("grep -r foo ."), null);
  assert.equal(powershellParseError("export FOO=1"), null);
  assert.equal(powershellParseError("npm run build; npm test"), null);
  assert.equal(powershellParseError(`Write-Output "a && b"`), null); // quoted, not real
});

// ── Fix D: assigning to a read-only automatic variable ($pid) ──

test("powershellReservedAssignmentReason: flags assignment to read-only automatic vars", () => {
  assert.match(powershellReservedAssignmentReason("$pid = $t[$t.Count-1]")!, /read-only automatic variable/);
  assert.match(powershellReservedAssignmentReason("$PID=1234")!, /\$procId/);
  assert.match(powershellReservedAssignmentReason("$Host = 'x'")!, /Host/);
  assert.ok(powershellReservedAssignmentReason("$ExecutionContext = $y"));
  assert.ok(powershellReservedAssignmentReason("$pid += 1"));
});

test("powershellReservedAssignmentReason: does NOT flag reading or comparing them", () => {
  assert.equal(powershellReservedAssignmentReason("if ($pid -eq 0) { }"), null);
  assert.equal(powershellReservedAssignmentReason("Write-Output $pid"), null);
  assert.equal(powershellReservedAssignmentReason("Stop-Process -Id $pid"), null);
  // A normal variable named similarly is fine.
  assert.equal(powershellReservedAssignmentReason("$procId = 5"), null);
  // Literal inside a quoted string must not trip it.
  assert.equal(powershellReservedAssignmentReason(`Write-Output "$pid = here"`), null);
});
