/**
 * compactionHygiene.test.ts — the long-work context-hygiene additions: condensing
 * old assistant recaps (so finished tasks can't resurface), the aggressive
 * task-boundary keep, and the continuation detector that guards the boundary sweep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { microcompact, isContinuation, KEEP_LAST_N_BOUNDARY } from "./compaction.js";
import type { Entry } from "./types.js";

const recap = (text: string): Entry => ({ role: "assistant", content: text });
const userMsg = (text: string): Entry => ({ role: "user", content: text });
const longRecap = "Session 6 delivered the folder tree, context menu, and SVG icons. ".repeat(6);

test("old standalone assistant recaps are condensed; recent ones are kept", () => {
  const entries: Entry[] = [
    recap(longRecap), // old — should be stubbed
    ...Array.from({ length: 8 }, (_, i) => userMsg(`turn ${i}`)),
    recap(longRecap), // within the recent window — kept
  ];
  const { entries: out, recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 1, "one old recap condensed");
  assert.notEqual(out[0]!.content, longRecap, "old recap was replaced with a stub");
  assert.equal(out.at(-1)!.content, longRecap, "recent recap untouched");
});

test("short acknowledgements are NOT condensed (only real recaps)", () => {
  const entries: Entry[] = [recap("Done."), ...Array.from({ length: 9 }, (_, i) => userMsg(`t${i}`))];
  const { recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 0);
});

test("an assistant message WITH tool calls is never recap-stubbed (keeps tool pairing)", () => {
  const withCalls: Entry = { role: "assistant", content: longRecap, toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }] };
  const entries: Entry[] = [withCalls, ...Array.from({ length: 9 }, (_, i) => userMsg(`t${i}`))];
  const { recapsCleared, entries: out } = microcompact(entries, 8);
  assert.equal(recapsCleared, 0);
  assert.equal(out[0]!.content, longRecap, "narration tied to a tool call is preserved");
});

test("the boundary keep is much tighter than the normal keep", () => {
  assert.ok(KEEP_LAST_N_BOUNDARY < 8);
});

const bigContent = "x".repeat(4000);
// Narrow a union Entry to an assistant's tool calls (throws if it isn't one).
function toolCallsOf(e: Entry) {
  if (e.role === "assistant" && e.toolCalls) return e.toolCalls;
  throw new Error("expected an assistant entry with tool calls");
}
// A write of a whole file, its result, then a LATER tool round so the write is old.
function writeThenLaterRound(): Entry[] {
  return [
    userMsg("build the app shell"),
    { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: bigContent }) }] },
    { role: "tool", toolCallId: "w1", content: "wrote src/App.tsx (820 lines)" },
    { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "src/x.ts" }) }] },
    { role: "tool", toolCallId: "r1", content: "file body" },
  ];
}

test("old edit/write tool-call INPUTS are cleared once the write is stale", () => {
  const { entries: out, inputsCleared } = microcompact(writeThenLaterRound(), 1);
  assert.equal(inputsCleared, 1, "the stale write's input was cleared");
  const args = JSON.parse(toolCallsOf(out[1]!)[0]!.arguments) as Record<string, unknown>;
  assert.ok(!("content" in args), "the 820-line content payload is gone");
  assert.equal(args.path, "src/App.tsx", "which file was edited is preserved");
  assert.ok(typeof args._cleared === "string", "a cleared marker is left");
});

test("clearing INPUTs is idempotent — a second pass clears nothing", () => {
  const once = microcompact(writeThenLaterRound(), 1);
  const twice = microcompact(once.entries, 1);
  assert.equal(twice.inputsCleared, 0, "already-cleared inputs are left alone");
});

test("a RECENT write keeps its full input (only stale ones are cleared)", () => {
  // keepLastN large enough that the write's result stays in the recent window.
  const { inputsCleared, entries: out } = microcompact(writeThenLaterRound(), 8);
  assert.equal(inputsCleared, 0);
  const args = JSON.parse(toolCallsOf(out[1]!)[0]!.arguments) as Record<string, unknown>;
  assert.equal(args.content, bigContent, "recent write content untouched");
});

test("isContinuation: trivial continuations vs genuine new tasks", () => {
  for (const t of ["continue", "keep going", "go ahead", "yes", "ok", "next", "  proceed  "]) {
    assert.equal(isContinuation(t), true, `"${t}" is a continuation`);
  }
  for (const t of [
    "now add drag and drop between folders",
    "delete the selective-delete feature and add word count",
    "the icons look wrong, redo them as filled shapes instead",
  ]) {
    assert.equal(isContinuation(t), false, `"${t}" is a new task`);
  }
});
