/**
 * autoMemory.test.ts — the cross-session memory store and the save_memory tool.
 *
 * Pointed at a temp HOME so it never touches the real ~/.mindweave (same scheme as
 * memory.test.ts). Covers: writing a topic file + index pointer, loading the
 * index, update-not-duplicate on the same name, and the tool's ask-before-save
 * gate (save / decline / adjust) plus type validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const { saveMemory, loadMemoryIndex, memoryDir, slugify } = await import("./autoMemory.js");
const { saveMemoryTool } = await import("../tools/saveMemory.js");
type ToolContext = import("../tools/types.js").ToolContext;

function input(over: Partial<Parameters<typeof saveMemory>[1]> = {}) {
  return {
    name: "User role",
    description: "who the user is",
    type: "user" as const,
    body: "The user is a senior engineer building a terminal agent.",
    indexLine: "senior engineer, building a terminal agent",
    ...over,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

test("saveMemory writes a topic file and an index pointer", async () => {
  const cwd = "/proj/mem-a";
  const saved = await saveMemory(cwd, input());
  assert.equal(saved.updated, false);
  assert.equal(saved.file, "user-role.md");

  const topic = await fs.readFile(join(memoryDir(cwd), "user-role.md"), "utf8");
  assert.match(topic, /name: User role/);
  assert.match(topic, /type: user/);
  assert.match(topic, /senior engineer building a terminal agent/);

  const index = await fs.readFile(join(memoryDir(cwd), "MEMORY.md"), "utf8");
  assert.match(index, /# Memory Index/);
  assert.match(index, /\[User role\]\(user-role\.md\)/);
});

test("loadMemoryIndex returns the index, or empty when none", async () => {
  assert.equal(await loadMemoryIndex("/proj/mem-empty"), "");
  const cwd = "/proj/mem-b";
  await saveMemory(cwd, input({ name: "Build tool", type: "project", indexLine: "uses pnpm" }));
  const idx = await loadMemoryIndex(cwd);
  assert.match(idx, /\[Build tool\]\(build-tool\.md\) — uses pnpm/);
});

test("saving the same name updates instead of duplicating", async () => {
  const cwd = "/proj/mem-c";
  await saveMemory(cwd, input({ indexLine: "first" }));
  const second = await saveMemory(cwd, input({ indexLine: "second, revised", body: "Revised." }));
  assert.equal(second.updated, true);

  const index = await fs.readFile(join(memoryDir(cwd), "MEMORY.md"), "utf8");
  const hits = index.match(/user-role\.md/g) ?? [];
  assert.equal(hits.length, 1, "exactly one index line for the file");
  assert.match(index, /second, revised/);
  assert.doesNotMatch(index, /— first/);

  const topic = await fs.readFile(join(memoryDir(cwd), "user-role.md"), "utf8");
  assert.match(topic, /Revised\./);
});

test("slugify produces a safe file stem", () => {
  assert.equal(slugify("User Role!"), "user-role");
  assert.equal(slugify("  "), "memory");
});

// ── the save_memory tool ────────────────────────────────────────────────────

function ctxWith(): ToolContext {
  // An approval channel is provided to prove save_memory NEVER calls it — saving is
  // silent and automatic now, not gated on a yes/no.
  return {
    cwd: `/proj/tool-${Math.random().toString(36).slice(2)}`,
    reads: new Map(),
    todos: [],
    requestApproval: async () => {
      throw new Error("save_memory must not prompt the user");
    },
  };
}

test("save_memory writes silently without prompting the user", async () => {
  const ctx = ctxWith();
  const res = await saveMemoryTool.execute(
    { name: "Pref terse", description: "wants terse replies", type: "feedback", body: "Be terse.", index_line: "terse" },
    ctx,
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /Saved memory 'Pref terse'/);
  const index = await fs.readFile(join(memoryDir(ctx.cwd), "MEMORY.md"), "utf8");
  assert.match(index, /Pref terse/);
});

test("save_memory rejects an invalid type", async () => {
  const ctx = ctxWith();
  const res = await saveMemoryTool.execute(
    { name: "Bad", description: "x", type: "notatype", body: "x", index_line: "x" },
    ctx,
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /type/);
});
