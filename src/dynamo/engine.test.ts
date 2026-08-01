/**
 * engine.test.ts — stopReasonNote (pure) + the pause paths' one structural rule.
 *
 * The full agent loop isn't unit-tested here (it needs a live session and tool
 * context), but the wording shown to the user when a turn ends early is pure and
 * worth pinning: every non-"end" StopReason must produce a distinct, honest
 * explanation, so a truncated reply is never confused with a refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stopReasonNote } from "./engine.js";
import type { StopReason } from "../drivers/types.js";

test("every early-stop reason gets its own, distinct explanation", () => {
  const reasons: Exclude<StopReason, "end">[] = ["truncated", "refused", "overflow", "overloaded"];
  const notes = reasons.map(stopReasonNote);
  assert.equal(new Set(notes).size, reasons.length, "two different reasons produced the same wording");
  for (const note of notes) assert.ok(note.length > 0);
});

test("truncated and overloaded both read as incomplete, but name a different cause", () => {
  const truncated = stopReasonNote("truncated");
  const overloaded = stopReasonNote("overloaded");
  assert.match(truncated, /incomplete/);
  assert.match(overloaded, /incomplete/);
  assert.notEqual(truncated, overloaded);
});

// ---------------------------------------------------------------------------
// Every pause must reach the SCREEN, not just the transcript.
//
// A source scan, which is unusual, and deliberate. This bug cannot fail loudly:
// a pause helper that only pushes to the transcript type-checks, passes every
// test, and returns a perfectly good string — the turn just ends with a blank
// screen and the user reads it as a crash. That happened. The only mechanical way
// to catch the next one is to check the shape of the code, the same approach
// promptAssembly.test.ts and providerNeutrality.test.ts take for their own
// silent failures.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("endTurnWith puts the pause message on the wire, not only in the transcript", () => {
  const body = engineSource.match(/function endTurnWith\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "endTurnWith not found — did it get renamed?");
  assert.match(body, /transcript\.push/, "the pause must be recorded for the next model turn");
  assert.match(body, /onEvent\?\.\(\s*\{\s*type:\s*"text"/, "the pause must also be emitted to the UI");
});

test("no pause helper ends a turn without going through endTurnWith", () => {
  const helpers = [...engineSource.matchAll(/\nfunction (pause\w*)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
  assert.ok(helpers.length >= 4, `expected the known pause helpers, found ${helpers.length}`);
  for (const [, name, body] of helpers) {
    assert.match(
      body!,
      /endTurnWith\(/,
      `${name} composes a message the user never sees — route it through endTurnWith`,
    );
  }
});

test("session memory is swept at turn END, not only at turn start", () => {
  // The turn-start check works one turn behind: it can only see what happened BEFORE
  // this turn ran. A session whose last turn did the real work therefore ended with
  // notes that never mentioned it, and a later read_session found nothing useful.
  // This bug cannot fail loudly — the notes are just quietly thinner — so it is pinned
  // structurally, the same way endTurnWith is.
  const sweeps = [...engineSource.matchAll(/sweepSessionMemory\(session, options\)/g)];
  assert.ok(sweeps.length >= 2, `expected a sweep at turn start AND turn end, found ${sweeps.length}`);
  assert.match(
    engineSource,
    /if \(!options\.signal\?\.aborted\) await sweepSessionMemory/,
    "the end-of-turn sweep must be skipped on abort — Esc should not buy a background model call",
  );
});

test("the end-of-turn sweep is not in the finally block", () => {
  // `finally` also runs on throw and on abort. A model call there would fire on paths
  // the user never paid for and cannot see.
  const finallyBody = engineSource.match(/\} finally \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(finallyBody, "the turn's finally block not found — did it get restructured?");
  assert.doesNotMatch(finallyBody, /sweepSessionMemory/);
});

test("the turn's MCP tools come from ONE snapshot, not two live reads", () => {
  // Reading live state twice let a server die between advertising a tool and
  // dispatching it, so the model could be refused a tool it had just been offered.
  // Silent when broken — the tool list still looks right — so it is pinned structurally.
  assert.match(engineSource, /mcp\?\.snapshot\(/, "the turn must take a snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.toolSchemas\(/, "the advertised list must come from the snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.asTool\(/, "dispatch must come from the same snapshot");
});

test("compaction counts the MCP catalog, not just the transcript", () => {
  // Tool schemas are sent every turn but live outside the transcript, so the bars could
  // not see them and fired that much too late. Also silent when broken.
  const body = engineSource.match(/async function maybeCompact\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "maybeCompact not found — did it get renamed?");
  assert.match(body, /estimatedTokens\(\)/, "the catalog's cost must be computed");
  // Computing it is not enough: the figure the bars are compared against has to
  // actually include it. Asserting only that the call appears passes even when the
  // result is dropped on the floor.
  const used = body.match(/const used = \(\) =>([^;]*);/)?.[1];
  assert.ok(used, "the budget helper not found — did it get renamed?");
  assert.match(used, /estimateEntriesTokens\(session\.transcript\)/, "the transcript is part of the budget");
  assert.match(used, /mcpTokens/, "and so is the MCP catalog");
  assert.doesNotMatch(body, /estimateEntriesTokens\(session\.transcript\) >=/, "no bar may be compared against the transcript alone");
});

test("the tool list is rebuilt per STEP, so a searched tool is callable at once", () => {
  // A large MCP catalog is held behind find_mcp_tools. If the tool list were fixed at
  // turn start, the model would search, be told a tool was loaded, and then still not
  // be able to call it until the next user message — a lie it cannot diagnose.
  // Silent when broken: the search still reports success.
  assert.match(engineSource, /const stepTools = \(\) =>/, "the tool list must be a per-step function");
  const call = engineSource.match(/buildRequest\(session,[^)]*\)/)?.[0];
  assert.ok(call, "buildRequest call not found — did the signature change?");
  assert.match(call, /stepTools\(\)/, "each step must send the CURRENT tool list");
});
