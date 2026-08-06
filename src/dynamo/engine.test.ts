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

test("compaction counts the whole prompt, not just the transcript", () => {
  // Everything sent every turn but living outside the transcript — the system prompt,
  // every tool schema, the working-set block, the relevance map — used to be invisible
  // to the bars, so they fired that much too late. Also silent when broken.
  const body = engineSource.match(/async function maybeCompact\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "maybeCompact not found — did it get renamed?");
  // Computing an overhead is not enough: the figure the bars are compared against has
  // to actually include it. Asserting only that the term appears passes even when the
  // result is dropped on the floor.
  const used = body.match(/const used = \(\) =>([^;]*);/)?.[1];
  assert.ok(used, "the budget helper not found — did it get renamed?");
  assert.match(used, /estimateEntriesTokens\(session\.transcript\)/, "the transcript is part of the budget");
  assert.match(used, /overhead/, "and so is everything outside the transcript");
  // Both halves of the overhead must survive: the MEASURED prompt size once a call has
  // reported one, and the catalog estimate as the fallback before that. Lose either and
  // the bars go blind again to whichever is missing.
  assert.match(body, /const overhead =/, "the overhead term not found — did it get renamed?");
  assert.match(body, /contextOverhead/, "the measured prompt size is preferred");
  assert.match(body, /estimatedTokens\(\)/, "with the MCP catalog as the fallback");
  // A measurement from ANOTHER model must not be reused: switching provider changes the
  // tool-schema serialisation and the prompt shape, so the figure stops being about this
  // request. Without this comparison the first call after a /provider switch sizes its
  // bars from the old provider's prompt.
  assert.match(body, /\.model === model/, "a measurement from another model must not be reused");
  // And the measured branch must actually be fed, or it is dead code that reads as safety.
  assert.match(
    engineSource,
    /contextOverhead = \{/,
    "reported usage must be recorded as the overhead",
  );
  assert.match(engineSource, /tokens: measuredOverhead\(/, "…with the measured figure");
  assert.match(engineSource, /model: session\.modelConfig\.model/, "…and the model it belongs to");
  assert.doesNotMatch(body, /estimateEntriesTokens\(session\.transcript\) >=/, "no bar may be compared against the transcript alone");
});

test("the tool list is rebuilt per STEP, so a searched tool is callable at once", () => {
  // A large MCP catalog is held behind find_mcp_tools. If the tool list were fixed at
  // turn start, the model would search, be told a tool was loaded, and then still not
  // be able to call it until the next user message — a lie it cannot diagnose.
  // Silent when broken: the search still reports success.
  assert.match(engineSource, /const stepTools = \(\) =>/, "the tool list must be a per-step function");
  // Match to the end of the argument list rather than to the first `)`, so an argument
  // that is itself a call (or a reformat onto several lines) doesn't silently truncate
  // the match and turn this into a test that passes by finding nothing.
  const call = engineSource.match(/const request = buildRequest\([\s\S]*?\n\s*\);/)?.[0];
  assert.ok(call, "buildRequest call not found — did the signature change?");
  assert.match(call, /stepTools\(\)/, "each step must send the CURRENT tool list");
});

test("the summarizer's reply is gated before it can replace the transcript", () => {
  // Silent when broken: an accepted bad summary looks identical to a good one, and
  // the conversation it replaced is already gone.
  const body = engineSource.match(/async function autocompact\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "autocompact not found — did it move?");
  assert.match(body, /usableSummary\(turn\.content, turn\.stop\)/, "the stop reason must be part of the decision");
  assert.doesNotMatch(body, /const \{ content \}/, "destructuring content alone discards the stop reason");
});

test("EVERY summarizer rejection counts toward the circuit breaker", () => {
  // A rejection that doesn't count means a doomed summarizer is called on every step
  // forever, which is the runaway the breaker exists to stop.
  const body = engineSource.match(/async function autocompact\([\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  // Pin the property, not a count: BOTH ways out — a thrown error and a reply that
  // came back unusable — have to go through the same failure path.
  assert.match(body, /if \(!usable\) return void fail\(\);/, "an unusable reply must count as a failure");
  assert.match(body, /\} catch \{\s*\n\s*return void fail\(\);/, "a thrown error must count as a failure");
  assert.doesNotMatch(body, /if \(!summary\) return;/, "a bare return skips the breaker");
});

test("microcompaction's result is never discarded on a counter nobody remembered", () => {
  // Gating the write on a hand-picked subset meant a pass that only cleared edit inputs
  // or only evicted images did the work and threw it away.
  const body = engineSource.match(/if \(used\(\) >= microBar\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(body, "microcompact block not found");
  assert.match(body, /session\.transcript = microcompact\(session\.transcript\)\.entries;/);
  assert.doesNotMatch(body, /cleared > 0 \|\| recapsCleared > 0/, "no counter subset may gate the write");
});
