/**
 * agentData.test.ts — keeping other coding agents' data separate from ours.
 *
 * A project that has been worked on by more than one tool carries several agents'
 * private data side by side: saved sessions, memory of past conversations, rules,
 * skills. Reading someone else's is how a model ends up quoting a conversation it
 * never had, or inheriting decisions the user never made with it.
 *
 * These tests pin three things:
 *   1. Another tool's data is recognized, and OURS is not caught by mistake.
 *   2. A content search can't print what a direct read would ask about first.
 *   3. A shell command can't walk around the per-file gates entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  excludedFromSearch,
  foreignAgentReason,
  protectedPathReason,
  sensitiveCommandReason,
} from "./guard.js";

// ── Recognizing another tool's data ───────────────────────────────────────────

test("another agent's directories and files are recognized, with the tool named", () => {
  assert.equal(foreignAgentReason("/proj/.cursor/rules/abc.md"), "Cursor");
  assert.equal(foreignAgentReason("/proj/.claude/settings.json"), "Claude Code");
  assert.equal(foreignAgentReason("/proj/CLAUDE.md"), "Claude Code");
  assert.equal(foreignAgentReason("/proj/.cursorrules"), "Cursor");
  assert.equal(foreignAgentReason("/proj/.cursor/rules/x.md"), "Cursor");
  assert.equal(foreignAgentReason("/proj/.aider.chat.history.md"), "Aider");
  assert.equal(foreignAgentReason("/proj/.continue/config.json"), "Continue");
  assert.equal(foreignAgentReason("/proj/AGENTS.md"), "another coding agent");
});

test("Windows-style paths are recognized the same way", () => {
  assert.equal(foreignAgentReason("D:\\proj\\.cursor\\rules\\a.md"), "Cursor");
  assert.equal(foreignAgentReason("D:\\proj\\CLAUDE.md"), "Claude Code");
});

test("OUR OWN files are never mistaken for another tool's", () => {
  // The whole point is reading our own work, so these must stay open.
  for (const p of [
    "/proj/MINDWEAVE.md",
    "/proj/.mindweave/anything.md",
    "/home/u/.mindweave/projects/slug/memory/index.md",
    "/proj/src/index.ts",
    "/proj/README.md",
    "/proj/package.json",
  ]) {
    assert.equal(foreignAgentReason(p), null, `${p} should not be treated as another tool's data`);
  }
});

test("an ordinary file that merely mentions a tool's name is not caught", () => {
  // Substring matching would wrongly flag these; the patterns are path-segment based.
  assert.equal(foreignAgentReason("/proj/src/claude-client.ts"), null);
  assert.equal(foreignAgentReason("/proj/docs/cursor-notes.md"), null);
  assert.equal(foreignAgentReason("/proj/src/aiderHelper.ts"), null);
});

// ── The search bypass ─────────────────────────────────────────────────────────

test("search withholds BOTH secrets and other agents' data", () => {
  // Secrets: read_file already refuses these, so search must not print them either.
  assert.ok(excludedFromSearch("/proj/.env"));
  assert.ok(excludedFromSearch("/proj/.ssh/id_rsa"));
  assert.ok(excludedFromSearch("/proj/certs/key.pem"));
  // Another agent's saved conversations.
  assert.ok(excludedFromSearch("/proj/.cursor/rules/a.md"));
  assert.ok(excludedFromSearch("/proj/.claude/history.jsonl"));
});

test("search still covers ordinary project files, including our own notes", () => {
  for (const p of ["/proj/src/app.ts", "/proj/README.md", "/proj/MINDWEAVE.md", "/proj/.mindweave/notes.md"]) {
    assert.equal(excludedFromSearch(p), false, `${p} should remain searchable`);
  }
});

// ── The shell bypass ──────────────────────────────────────────────────────────

test("a shell command that would PRINT a secret is refused", () => {
  for (const cmd of [
    "cat .env",
    "type .env",
    "Get-Content .env",
    "gc ./.env.production",
    "cat ~/.ssh/id_rsa",
    "head -5 .env",
    "sed -n '1p' .env",
    "base64 certs/key.pem",
    "grep API_KEY .env",
    "npm test && cat .env",
    "while read l < .env; do echo $l; done",
  ]) {
    assert.ok(sensitiveCommandReason(cmd), `${cmd} should be refused`);
  }
});

test("a shell command that would print another agent's data is refused", () => {
  for (const cmd of [
    "cat .cursor/rules/a.md",
    "Get-Content .cursorrules",
    "tail -20 .claude/history.jsonl",
    "cat .aider.chat.history.md",
  ]) {
    assert.ok(sensitiveCommandReason(cmd), `${cmd} should be refused`);
  }
});

test("MENTIONING a sensitive path without reading it is allowed", () => {
  // The regression this pins: the model ran `Test-Path .../.env` to check whether
  // a file existed and was refused, costing a wasted turn. Existence checks,
  // listings, and copies never put the contents in context, so none of them are
  // the harm this guard exists to prevent.
  for (const cmd of [
    "Test-Path code-blue/backend/.env",
    "test -f .env && echo yes",
    "ls -la .env",
    "dir .claude",
    "Get-ChildItem .cursor",
    "cp .env.example .env",
    "Copy-Item .env.example .env",
    "rm -f .env.bak",
    "git status .env",
    "echo 'remember to set .env'",
  ]) {
    assert.equal(sensitiveCommandReason(cmd), null, `${cmd} should be allowed`);
  }
});

test("reading a NON-sensitive file is always fine", () => {
  for (const cmd of ["cat README.md", "Get-Content src/index.ts", "head -20 package.json", "grep TODO src/app.ts"]) {
    assert.equal(sensitiveCommandReason(cmd), null, `${cmd} should be allowed`);
  }
});

test("ordinary commands are untouched", () => {
  for (const cmd of [
    "npm test",
    "git status",
    "python manage.py check",
    "npm run build && npm link",
    "rg TODO src/",
    "npm run typecheck",
    "echo environment",
  ]) {
    assert.equal(sensitiveCommandReason(cmd), null, `${cmd} should be allowed`);
  }
});

// ── The two categories stay distinct ──────────────────────────────────────────

test("secrets and agent data are separate categories, not one list", () => {
  // A secret is never readable. Another agent's data is readable IF the user says so,
  // so it must not be lumped into the hard-refusal list.
  assert.ok(protectedPathReason("/proj/.env"));
  assert.equal(foreignAgentReason("/proj/.env"), null);

  assert.equal(protectedPathReason("/proj/.cursor/rules/a.md"), null);
  assert.ok(foreignAgentReason("/proj/.cursor/rules/a.md"));
});
