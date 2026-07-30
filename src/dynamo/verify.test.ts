import { test } from "node:test";
import assert from "node:assert/strict";
import { isFileMutation, mutationNeedsVerification, looksLikeVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, normalizeErrorSignature } from "./verify.js";

test("file mutations are the edit/write tools", () => {
  assert.ok(isFileMutation("edit_file"));
  assert.ok(isFileMutation("write_file"));
  assert.ok(isFileMutation("multi_edit"));
  assert.ok(!isFileMutation("read_file"));
  assert.ok(!isFileMutation("run_command"));
});

test("mutationNeedsVerification: code/config edits DO need a check", () => {
  assert.ok(mutationNeedsVerification("edit_file", { path: "src/dynamo/engine.ts" }));
  assert.ok(mutationNeedsVerification("write_file", { path: "src/App.tsx" }));
  assert.ok(mutationNeedsVerification("multi_edit", { path: "src-tauri/Cargo.toml" }));
  assert.ok(mutationNeedsVerification("write_file", { path: "package.json" }));
  assert.ok(mutationNeedsVerification("replace_symbol_body", { path: "lib.rs" }));
});

test("mutationNeedsVerification: docs-only edits do NOT trip the gate", () => {
  assert.ok(!mutationNeedsVerification("multi_edit", { path: "MINDWEAVE.md" }));
  assert.ok(!mutationNeedsVerification("write_file", { path: "docs/README.md" }));
  assert.ok(!mutationNeedsVerification("edit_file", { path: "notes.txt" }));
  assert.ok(!mutationNeedsVerification("write_file", { path: "CHANGELOG.mdx" }));
});

test("mutationNeedsVerification: non-mutations and unknown paths", () => {
  // A read is never a mutation, so it never needs verification.
  assert.ok(!mutationNeedsVerification("read_file", { path: "MINDWEAVE.md" }));
  assert.ok(!mutationNeedsVerification("run_command", { command: "npm test" }));
  // An extensionless or missing path is treated as code (safe default: gate fires).
  assert.ok(mutationNeedsVerification("write_file", { path: "Dockerfile" }));
  assert.ok(mutationNeedsVerification("edit_file", {}));
  // A dot in a directory name, not the filename, is not an extension.
  assert.ok(mutationNeedsVerification("write_file", { path: "my.docs/lib" }));
});

test("looksLikeVerification recognizes real checks", () => {
  for (const cmd of [
    "npm test",
    "npm run build",
    "pnpm run typecheck",
    "yarn lint",
    "npx tsc --noEmit",
    "tsc",
    "vitest run",
    "npx jest src/",
    "pytest -q",
    "mypy .",
    "ruff check .",
    "go test ./...",
    "cargo test",
    "cargo clippy",
    "make check",
    "eslint src",
  ]) {
    assert.ok(looksLikeVerification(cmd), `should detect: ${cmd}`);
  }
});

test("looksLikeVerification ignores ordinary commands", () => {
  for (const cmd of [
    "ls -la",
    "git status",
    "echo hello",
    "cat package.json",
    "cd src",
    "mkdir build", // 'build' as an argument to mkdir, not a build command
    "node server.js",
  ]) {
    assert.ok(!looksLikeVerification(cmd), `should NOT detect: ${cmd}`);
  }
});

test("isVerification counts diagnostics and check-like commands", () => {
  assert.ok(isVerification("diagnostics", {}));
  assert.ok(isVerification("run_command", { command: "npm test" }));
  assert.ok(!isVerification("run_command", { command: "git status" }));
  assert.ok(!isVerification("read_file", { path: "x" }));
});

test("reScopeCheck: an ordinary turn that never completes a list never pauses", () => {
  // Editing with an in-progress list — no completion yet, no pause.
  const r = reScopeCheck(false, [{ name: "edit_file", summary: "edited" }], [
    { status: "in_progress" },
    { status: "pending" },
  ]);
  assert.equal(r.completed, false);
  assert.equal(r.pause, false);
});

test("reScopeCheck: the completing step itself does not pause (list is cleared)", () => {
  // todo_write reports all done; the list clears to empty → nothing pending yet.
  const r = reScopeCheck(false, [{ name: "todo_write", summary: "all tasks completed" }], []);
  assert.equal(r.completed, true);
  assert.equal(r.pause, false);
});

test("reScopeCheck: a NEW pending list after a completion triggers the pause", () => {
  // Prior step already completed a list; now a fresh pending list appears.
  const r = reScopeCheck(true, [{ name: "todo_write", summary: "task list updated (0/7 done)" }], [
    { status: "pending" },
    { status: "pending" },
  ]);
  assert.equal(r.completed, true);
  assert.equal(r.pause, true);
});

test("reScopeCheck: finishing then answering (no new list) does not pause", () => {
  // Completed earlier, and the model is wrapping up — the list stays empty.
  const r = reScopeCheck(true, [{ name: "edit_file", summary: "edited" }], []);
  assert.equal(r.pause, false);
});

test("isBackgroundPollStep: a shell_output poll of a still-running shell is a poll step", () => {
  assert.equal(isBackgroundPollStep([{ name: "shell_output", summary: "shell #1 (running)" }]), true);
});

test("isBackgroundPollStep: list_shells with something running is a poll step", () => {
  assert.equal(isBackgroundPollStep([{ name: "list_shells", summary: "1 running, 1 total" }]), true);
});

test("isBackgroundPollStep: list_shells with nothing running is NOT a poll step", () => {
  // "0 running, 2 total" must not false-match on the word "running".
  assert.equal(isBackgroundPollStep([{ name: "list_shells", summary: "0 running, 2 total" }]), false);
});

test("isBackgroundPollStep: polling a FINISHED shell is not a poll step (model can report it)", () => {
  assert.equal(isBackgroundPollStep([{ name: "shell_output", summary: "shell #1 (exited 0)" }]), false);
});

test("isBackgroundPollStep: real work alongside a poll is not a poll step", () => {
  const step = [
    { name: "shell_output", summary: "shell #1 (running)" },
    { name: "edit_file", summary: "edited app.tsx" },
  ];
  assert.equal(isBackgroundPollStep(step), false);
});

test("isBackgroundPollStep: an empty step is not a poll step", () => {
  assert.equal(isBackgroundPollStep([]), false);
});

// ── Fix A: the repeat-failure breaker (pure) ──

test("stepFailureSignature: null unless EVERY result in the step errored", () => {
  assert.equal(stepFailureSignature([]), null);
  // A success alongside the failure = progress, so no signature (streak resets).
  assert.equal(
    stepFailureSignature([
      { name: "run_command", output: "boom", isError: true },
      { name: "read_file", output: "ok", isError: false },
    ]),
    null,
  );
  assert.ok(stepFailureSignature([{ name: "edit_file", output: "file not found", isError: true }]));
});

test("stepFailureSignature: same edit failing twice yields the same signature", () => {
  const a = stepFailureSignature([{ name: "edit_file", output: "file src/App.css not found. Use write_file.", isError: true }]);
  const b = stepFailureSignature([{ name: "edit_file", output: "file src/App.css not found. Use write_file.", isError: true }]);
  assert.equal(a, b);
});

test("stepFailureSignature: near-identical PowerShell $pid errors collapse to one signature", () => {
  // Transcript 2: different commands, same read-only-variable error. The code-echo and
  // char position differ; the stable message must make them match so the streak counts.
  const err1 =
    "Cannot overwrite variable PID because it is read-only or constant.\n" +
    "At line:1 char:80\n" +
    "+ ... ForEach-Object { $t = $_ -split ' '; $pid = $t[$t.Count-1]; if ($p ...\n" +
    "+                                             ~~~~~~~~~~~~~~~~~~~~~\n" +
    "    + CategoryInfo          : WriteError: (PID:String) [], SessionStateUnauthorizedAccessException";
  const err2 =
    "Cannot overwrite variable PID because it is read-only or constant.\n" +
    "At line:1 char:99\n" +
    "+ ... ForEach-Object { $parts = $_ -split ' '; $pid = $parts[-1]; if ($p ...\n" +
    "+                                                 ~~~~~~~~~~~~~~~~~\n" +
    "    + CategoryInfo          : WriteError: (PID:String) [], SessionStateUnauthorizedAccessException";
  const a = stepFailureSignature([{ name: "run_command", output: err1, isError: true }]);
  const b = stepFailureSignature([{ name: "run_command", output: err2, isError: true }]);
  assert.ok(a);
  assert.equal(a, b);
});

test("stepFailureSignature: genuinely different errors do NOT match", () => {
  const a = stepFailureSignature([{ name: "run_command", output: "Cannot overwrite variable PID because it is read-only or constant.", isError: true }]);
  const b = stepFailureSignature([{ name: "run_command", output: "Cannot bind argument to parameter 'Id' because it is null.", isError: true }]);
  assert.notEqual(a, b);
});

test("normalizeErrorSignature: drops code-echo/caret/location noise and digits", () => {
  const sig = normalizeErrorSignature(
    "Cannot overwrite variable PID because it is read-only or constant.\nAt line:1 char:80\n+ $pid = 5\n~~~~~~~",
  );
  assert.match(sig, /cannot overwrite variable pid/);
  assert.doesNotMatch(sig, /char:|~|line:/);
});
