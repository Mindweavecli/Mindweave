/**
 * transcript.test.ts — the transcript state machine: silent token accumulation
 * (whole-block reveal), narration sealing, tool lifecycle, and the drain ordering
 * that keeps the live region tiny and blocks in order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, type Action, type TranscriptState } from "./transcript.js";
import { isGroupable } from "./toolDisplay.js";

test("only read-only discovery tools group — edits, writes, runs, tests never do", () => {
  // Read-only discovery + silent status checks fold into the group. diagnostics joins
  // them: its one-line summary carries into the group note (red on failure) and the
  // model still gets the full listing via the tool output, so collapsing loses nothing.
  for (const n of ["read_file", "read_symbol", "glob", "grep", "list_dir", "outline", "definition", "references", "relevant", "diagnostics"]) {
    assert.ok(isGroupable(n), `${n} should group (silent receipt — collapsing loses nothing)`);
  }
  // Anything whose row carries output you need to see (a diff, command/test output,
  // fetched content, the meta result) must keep its own row.
  for (const n of ["edit_file", "multi_edit", "replace_symbol_body", "write_file", "run_command", "todo_write", "create_skill", "use_skill", "web_fetch", "spawn_subagent"]) {
    assert.ok(!isGroupable(n), `${n} must NOT group`);
  }
});

function run(actions: Action[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

test("tokens accumulate silently — the block shows nothing until it seals", () => {
  const s = run([
    { type: "token", delta: "Hel" },
    { type: "token", delta: "lo" },
  ]);
  // Open assistant block exists but its visible text is still empty.
  const block = s.tail.find((b) => b.kind === "assistant");
  assert.ok(block && block.kind === "assistant" && block.text === "");
  assert.equal(s.raw, "Hello");
  assert.equal(s.committed.length, 0);
});

test("finishReply seals the whole text at once and commits it", () => {
  const s = run([
    { type: "token", delta: "Hello world" },
    { type: "finishReply" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal((s.committed[0] as { text: string }).text, "Hello world");
  assert.equal(s.lastReply, "Hello world");
});

test("an empty assistant block is dropped, not committed", () => {
  const s = run([{ type: "token", delta: "   " }, { type: "finishReply" }]);
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 0);
});

test("toolStart seals pending narration, then shows the tool running", () => {
  const s = run([
    { type: "token", delta: "Let me check." },
    { type: "toolStart", toolId: "a", name: "Read", arg: "x.ts" },
  ]);
  // Narration committed; tool running in the tail.
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal(s.tail.length, 1);
  const tool = s.tail[0]!;
  assert.ok(tool.kind === "tool" && tool.status === "running" && tool.name === "Read");
});

test("toolEnd resolves the tool and drains it to committed", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "home.html" },
    { type: "toolEnd", toolId: "a", ok: true, summary: "1 replacement", detail: "- old\n+ new" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  const tool = s.committed[0]!;
  assert.ok(tool.kind === "tool" && tool.status === "ok" && tool.detail === "- old\n+ new");
});

test("a failed tool resolves to error status", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Run", arg: "npm test" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "exit 1" },
  ]);
  assert.equal((s.committed[0] as { status: string }).status, "error");
});

test("drain keeps order — a finished later tool waits behind an unfinished earlier one", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts" },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts" },
    { type: "toolEnd", toolId: "b", ok: true, summary: "done" }, // second finishes first
  ]);
  // Nothing commits yet — the first tool is still running, so the second can't
  // print ahead of it.
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 2);

  const s2 = reduce(s, { type: "toolEnd", toolId: "a", ok: true, summary: "done" });
  // Now both drain, in start order.
  assert.equal(s2.committed.length, 2);
  assert.equal((s2.committed[0] as { arg: string }).arg, "a.ts");
  assert.equal((s2.committed[1] as { arg: string }).arg, "b.ts");
});

// ── discovery grouping ────────────────────────────────────────────────────────

test("consecutive discovery calls fold into one live group, not separate rows", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
    { type: "toolStart", toolId: "c", name: "Glob", arg: "**/*", group: true },
  ]);
  assert.equal(s.tail.length, 1, "one group block, not three rows");
  const g = s.tail[0]!;
  assert.ok(g.kind === "tools" && g.items.length === 3 && !g.done);
  assert.equal(s.committed.length, 0, "stays live until closed");
});

test("toolEnd resolves a group item in place, group stays open", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
  ]);
  const g = s.tail[0]!;
  assert.ok(g.kind === "tools");
  assert.equal(g.items[0]!.status, "ok");
  assert.equal(g.items[1]!.status, "running");
  assert.equal(s.committed.length, 0);
});

test("the discovery group commits when the turn ends", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "finishReply" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  assert.ok(s.committed[0]!.kind === "tools" && s.committed[0]!.done);
});

test("narration closes the group; later reads start a fresh one", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "token", delta: "Found it." },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
  ]);
  assert.equal(s.committed.length, 2);
  assert.equal(s.committed[0]!.kind, "tools");
  assert.equal(s.committed[1]!.kind, "assistant");
  assert.ok(s.tail[0]!.kind === "tools" && (s.tail[0]!).items.length === 1);
});

test("a mutating tool closes the group and keeps its own row with detail", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "toolStart", toolId: "w", name: "Update", arg: "a.ts" }, // no group flag → individual
  ]);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "tools");
  assert.equal(s.tail.length, 1);
  assert.ok(s.tail[0]!.kind === "tool" && s.tail[0]!.name === "Update");
});

// ── sub-agent nested rail ─────────────────────────────────────────────────────

test("subagentStart opens a live nested block; its tool calls fold into the rail", () => {
  const s = run([
    { type: "subagentStart", agentId: "sub1", task: "find authFetch call sites", readOnly: true },
    { type: "subToolStart", agentId: "sub1", toolId: "a", name: "Search", arg: "authFetch" },
    { type: "subToolStart", agentId: "sub1", toolId: "b", name: "Read", arg: "login.ts" },
  ]);
  assert.equal(s.tail.length, 1, "one nested block, not separate rows");
  const blk = s.tail[0]!;
  assert.ok(blk.kind === "subagent" && !blk.done && blk.readOnly);
  assert.equal(blk.kind === "subagent" ? blk.items.length : 0, 2);
  assert.equal(s.committed.length, 0, "stays live until it reports back");
});

test("subToolEnd resolves a rail item in place, the sub-agent block stays open", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
    { type: "subToolStart", agentId: "s", toolId: "a", name: "Read", arg: "x.ts" },
    { type: "subToolEnd", agentId: "s", toolId: "a", ok: true, summary: "Read x.ts (12 lines)" },
  ]);
  const blk = s.tail[0]!;
  assert.ok(blk.kind === "subagent" && !blk.done);
  const item = blk.kind === "subagent" ? blk.items[0]! : undefined;
  assert.equal(item?.status, "ok");
  assert.equal(item?.note, "Read x.ts (12 lines)");
});

test("subagentEnd seals the sub-agent and drains it to committed with its summary", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: false },
    { type: "subToolStart", agentId: "s", toolId: "a", name: "Read", arg: "x.ts" },
    { type: "subToolEnd", agentId: "s", toolId: "a", ok: true },
    { type: "subagentEnd", agentId: "s", ok: true, summary: "3 steps" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  const blk = s.committed[0]!;
  assert.ok(blk.kind === "subagent" && blk.done && blk.status === "ok" && blk.summary === "3 steps");
});

test("a failed sub-agent seals to error status", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
    { type: "subagentEnd", agentId: "s", ok: false, summary: "failed" },
  ]);
  assert.equal((s.committed[0] as { status: string }).status, "error");
});

test("narration before a sub-agent is sealed first, then the rail opens", () => {
  const s = run([
    { type: "token", delta: "Delegating the search." },
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
  ]);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal(s.tail.length, 1);
  assert.equal(s.tail[0]!.kind, "subagent");
});

test("parallel sub-agents keep separate rails, keyed by agentId", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "auth", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "api", readOnly: true },
    { type: "subToolStart", agentId: "a", toolId: "1", name: "Read", arg: "auth.ts" },
    { type: "subToolStart", agentId: "b", toolId: "2", name: "Read", arg: "api.ts" },
    { type: "subToolStart", agentId: "a", toolId: "3", name: "Read", arg: "login.ts" },
  ]);
  const a = s.tail.find((x) => x.kind === "subagent" && x.agentId === "a");
  const b = s.tail.find((x) => x.kind === "subagent" && x.agentId === "b");
  assert.equal(a?.kind === "subagent" ? a.items.length : 0, 2);
  assert.equal(b?.kind === "subagent" ? b.items.length : 0, 1);
});

test("note and say commit directly without disturbing a streaming block", () => {
  const s = run([
    { type: "token", delta: "partial" },
    { type: "note", text: "a header" },
  ]);
  // The note is queued in the tail behind the unfinished assistant block (order
  // preserved), so it isn't committed ahead of it.
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 2);

  const done = run([{ type: "say", text: "hello" }]);
  assert.equal(done.committed.length, 1);
  assert.equal(done.committed[0]!.kind, "assistant");
});
