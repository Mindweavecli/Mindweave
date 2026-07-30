/**
 * subagent.test.ts — spawn_subagent guard paths + forkSession isolation.
 *
 * The happy path (spawn → run child → summary) reuses the real engine/model loop and
 * is covered by the live TUI smoke test; here we verify the parts that must hold
 * WITHOUT a model: the recursion/availability/empty guards, and that a forked child
 * is properly isolated from (yet shares the right state with) its parent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import type { Session } from "../memory/types.js";
import { spawnSubagent, Semaphore, clampSteps } from "./subagent.js";
import { callIsConcurrencySafe } from "../dynamo/engine.js";
import { forkSession } from "../memory/session.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/proj", reads: new Map(), todos: [], ...overrides };
}

test("spawn_subagent requires a task", async () => {
  const r = await spawnSubagent.execute({}, ctx({ forkChild: () => ({}) as Session }));
  assert.equal(r.isError, true);
  assert.match(r.output, /`task` is required/);
});

test("spawn_subagent refuses to recurse past the depth cap", async () => {
  const r = await spawnSubagent.execute(
    { task: "do a thing" },
    ctx({ subagentDepth: 1, forkChild: () => ({}) as Session }),
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /cannot spawn another sub-agent/);
});

test("spawn_subagent fails cleanly when the context can't fork (no engine)", async () => {
  const r = await spawnSubagent.execute({ task: "do a thing" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /aren't available/);
});

// ── parallelism: the concurrency predicate that drives fan-out ────────────────────

test("a read-only sub-agent is concurrency-safe (fans out); an editing one is not", () => {
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: true }), true);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: false }), false);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x" }), false); // default: runs alone
});

test("callIsConcurrencySafe: per-args predicate wins, else read-only ⇒ safe", () => {
  // A plain read-only tool with no predicate → safe.
  assert.equal(callIsConcurrencySafe({ readOnly: true }, {}), true);
  // A mutating tool with no predicate → not safe (serial lane).
  assert.equal(callIsConcurrencySafe({ readOnly: false }, {}), false);
  // The predicate overrides: mutating tool that declares itself safe for these args.
  assert.equal(callIsConcurrencySafe({ readOnly: false, isConcurrencySafe: (a) => a.ro === true }, { ro: true }), true);
  assert.equal(callIsConcurrencySafe({ readOnly: false, isConcurrencySafe: (a) => a.ro === true }, { ro: false }), false);
});

test("clampSteps bounds the budget and rejects junk", () => {
  assert.equal(clampSteps(5), 5);
  assert.equal(clampSteps(10_000), 60); // clamped to MAX_SUBAGENT_STEPS
  assert.equal(clampSteps(0), undefined);
  assert.equal(clampSteps(-3), undefined);
  assert.equal(clampSteps("nope"), undefined);
  assert.equal(clampSteps(undefined), undefined);
});

// ── Semaphore: bounded fan-out must NEVER exceed the limit, and all tasks finish ──

test("Semaphore never exceeds its limit and runs everything", async () => {
  const limit = 3;
  const sem = new Semaphore(limit);
  let active = 0;
  let maxActive = 0;
  let done = 0;
  const task = () =>
    sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      done++;
    });
  await Promise.all(Array.from({ length: 12 }, task));
  assert.equal(done, 12, "every queued task ran");
  assert.ok(maxActive <= limit, `never more than ${limit} at once, saw ${maxActive}`);
  assert.equal(maxActive, limit, "and it actually reached the limit (real concurrency)");
});

// ── forkSession ────────────────────────────────────────────────────────────────

const SHARED_CHASSIS = { marker: "shared" };

function parentSession(): Session {
  const toolContext: ToolContext = {
    cwd: "/proj",
    roots: ["/proj"],
    reads: new Map([["/proj/a.ts", { mtimeMs: 1, size: 1, full: true }]]),
    todos: [{ id: "1", text: "parent todo", status: "pending" }] as unknown as ToolContext["todos"],
    chassis: SHARED_CHASSIS as unknown as ToolContext["chassis"],
    guarded: true,
    subagentDepth: 0,
  };
  return {
    id: "parent",
    cwd: "/proj",
    createdAt: 1,
    transcript: [{ role: "user", content: "hello" }],
    toolContext,
    projectMemory: "MEM",
    memoryDir: "/proj/.mem",
    memoryIndex: "IDX",
    projectContext: "CTX",
    governance: {} as Session["governance"],
    modelConfig: {} as Session["modelConfig"],
  };
}

test("forkSession gives the child a fresh transcript seeded with the task", () => {
  const child = forkSession(parentSession(), "find all call sites of X");
  assert.notEqual(child.id, "parent");
  assert.equal(child.transcript.length, 1);
  assert.equal(child.transcript[0]!.role, "user");
  assert.match((child.transcript[0] as { content: string }).content, /sub-agent/);
  assert.match((child.transcript[0] as { content: string }).content, /find all call sites of X/);
});

test("forkSession isolates reads + todos but SHARES the code map", () => {
  const parent = parentSession();
  const child = forkSession(parent, "task");
  // Isolated: the child starts with an empty working set.
  assert.equal(child.toolContext.reads.size, 0);
  assert.equal(child.toolContext.todos.length, 0);
  // Parent's ledger is untouched.
  assert.equal(parent.toolContext.reads.size, 1);
  // Shared by reference: same chassis object, so the child sees the same code map.
  assert.equal(child.toolContext.chassis, SHARED_CHASSIS);
  // Inherits the parent's Sentinel gate.
  assert.equal(child.toolContext.guarded, true);
});

test("forkSession increments depth and applies read_only", () => {
  const parent = parentSession();
  const child = forkSession(parent, "task", { readOnly: true });
  assert.equal(child.toolContext.subagentDepth, 1);
  assert.equal(child.toolContext.readOnlyTools, true);
  // Project facts carry over by reference (same objects as the parent).
  assert.equal(child.projectMemory, "MEM");
  assert.equal(child.modelConfig, parent.modelConfig);
});
