/**
 * sessionTools.test.ts — the agent can actually read its own past work.
 *
 * Written against real files on disk, because the bug was never in the logic: the
 * sessions were saved correctly the whole time and simply had no reader. So these
 * save sessions the way the app does, then assert the tools find and report them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionsTool, readSessionTool, timeAgo } from "./sessionTools.js";
import { sessionDir } from "../memory/store.js";
import type { ToolContext } from "./types.js";

const project = mkdtempSync(join(tmpdir(), "mindweave-sessions-"));

const ctx = (sessionId?: string): ToolContext =>
  ({ cwd: project, roots: [project], reads: new Map(), todos: [], sessionId }) as unknown as ToolContext;

/** Write a saved session the same shape store.ts does: a meta file + notes. */
async function saveFixture(id: string, opts: { first: string; last: string; updatedAt: number; notes?: string }) {
  const dir = sessionDir(project);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, `${id}.meta.json`),
    JSON.stringify({
      id,
      cwd: project,
      createdAt: opts.updatedAt - 1000,
      updatedAt: opts.updatedAt,
      firstPrompt: opts.first,
      lastPrompt: opts.last,
      entryCount: 12,
    }),
  );
  if (opts.notes) await fs.writeFile(join(dir, `${id}.notes.md`), opts.notes);
}

const NOW = Date.now();

test("setup: two past sessions on disk", async () => {
  await saveFixture("aaaaaaaa-1111", {
    first: "fix the login 500",
    last: "run the tests",
    updatedAt: NOW - 2 * 86400_000,
    notes: "Fixed middleware ordering: RequestScoringMiddleware had to run first.",
  });
  await saveFixture("bbbbbbbb-2222", {
    first: "harden the rate limiter",
    last: "does manage.py check pass",
    updatedAt: NOW - 3600_000,
  });
});

test("list_sessions reports past sessions, newest first", async () => {
  const r = await listSessionsTool.execute({}, ctx());
  assert.equal(r.isError, undefined);
  assert.match(r.output, /harden the rate limiter/);
  assert.match(r.output, /fix the login 500/);
  assert.ok(
    r.output.indexOf("harden the rate limiter") < r.output.indexOf("fix the login 500"),
    "newest session must come first",
  );
});

test("list_sessions excludes the session you are currently in", async () => {
  const r = await listSessionsTool.execute({}, ctx("bbbbbbbb-2222"));
  assert.doesNotMatch(r.output, /harden the rate limiter/);
  assert.match(r.output, /fix the login 500/);
});

test("read_session answers with what that session actually recorded", async () => {
  const r = await readSessionTool.execute({ id: "aaaaaaaa-1111" }, ctx());
  assert.equal(r.isError, undefined);
  assert.match(r.output, /RequestScoringMiddleware had to run first/);
});

test("read_session defaults to the most recent past session", async () => {
  const r = await readSessionTool.execute({}, ctx());
  assert.match(r.output, /harden the rate limiter/);
});

test("read_session is honest when a session kept no notes", async () => {
  const r = await readSessionTool.execute({ id: "bbbbbbbb-2222" }, ctx());
  assert.match(r.output, /kept no notes/);
  // It still hands back what it does know, rather than nothing.
  assert.match(r.output, /harden the rate limiter/);
});

test("read_session rejects an unknown id instead of inventing one", async () => {
  const r = await readSessionTool.execute({ id: "nope" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /list_sessions/);
});

test("both tools are read-only", () => {
  assert.equal(listSessionsTool.readOnly, true);
  assert.equal(readSessionTool.readOnly, true);
});

test("a project with no history says so plainly", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mindweave-empty-"));
  const emptyCtx = { cwd: empty, roots: [empty], reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await listSessionsTool.execute({}, emptyCtx);
  assert.match(r.output, /No earlier sessions/);
});

test("timeAgo reads the way a person refers to past work", () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), "just now");
  assert.equal(timeAgo(now - 60_000, now), "1 minute ago");
  assert.equal(timeAgo(now - 7_200_000, now), "2 hours ago");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3 days ago");
  assert.equal(timeAgo(now - 14 * 86_400_000, now), "2 weeks ago");
});
