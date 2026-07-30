/**
 * newtools.test.ts — todo_write and web_fetch.
 *
 * todo_write is pure/deterministic and fully tested. web_fetch's network path is
 * gated behind MINDWEAVE_TEST_NETWORK (kept offline-green by default); its URL
 * validation and SSRF guard run always since they don't touch the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { todoWrite, todoListText } from "./todo.js";
import { webFetch } from "./webFetch.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] };
}

const TODOS = [
  { content: "Read the config", activeForm: "Reading the config", status: "completed" },
  { content: "Fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
  { content: "Run the tests", activeForm: "Running the tests", status: "pending" },
];

test("todo_write stores the list and reflects it in the prompt block", async () => {
  const c = ctx();
  const r = await todoWrite.execute({ todos: TODOS }, c);
  assert.equal(r.isError, undefined);
  assert.equal(c.todos.length, 3);
  const block = todoListText(c);
  assert.match(block, /\[x\] Read the config/);
  assert.match(block, /\[~\] Fixing the bug/); // in-progress shows active form
  assert.match(block, /\[ \] Run the tests/);
});

test("todo_write clears the list when everything is completed", async () => {
  const c = ctx();
  await todoWrite.execute({ todos: TODOS }, c);
  const allDone = TODOS.map((t) => ({ ...t, status: "completed" }));
  const r = await todoWrite.execute({ todos: allDone }, c);
  assert.equal(c.todos.length, 0);
  assert.match(r.output, /All tasks completed/);
  assert.equal(todoListText(c), "");
});

test("todo_write validates status and required fields", async () => {
  const c = ctx();
  const bad = await todoWrite.execute({ todos: [{ content: "x", activeForm: "x", status: "doing" }] }, c);
  assert.equal(bad.isError, true);
  assert.match(bad.output, /status must be one of/);
  const missing = await todoWrite.execute({ todos: [{ content: "x", status: "pending" }] }, c);
  assert.equal(missing.isError, true);
  assert.match(missing.output, /activeForm is required/);
});

test("todo_write notes more than one in_progress", async () => {
  const c = ctx();
  const two = [
    { content: "A", activeForm: "Aing", status: "in_progress" },
    { content: "B", activeForm: "Bing", status: "in_progress" },
  ];
  const r = await todoWrite.execute({ todos: two }, c);
  assert.match(r.output, /in_progress/);
});

test("web_fetch rejects a missing url", async () => {
  const r = await webFetch.execute({}, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /url. is required/);
});

test("web_fetch refuses localhost and private addresses (SSRF guard)", async () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1", "https://192.168.1.5", "http://10.0.0.1", "https://169.254.169.254/latest/meta-data"]) {
    const r = await webFetch.execute({ url }, ctx());
    assert.equal(r.isError, true, `${url} should be refused`);
    assert.match(r.output, /Refusing to fetch/);
  }
});

test("web_fetch rejects a non-http scheme", async () => {
  const r = await webFetch.execute({ url: "file:///etc/passwd" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /scheme|Unsupported/);
});

test(
  "web_fetch reads a real page and returns markdown (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 30_000 },
  async () => {
    const r = await webFetch.execute({ url: "https://example.com" }, ctx());
    assert.equal(r.isError, undefined);
    assert.match(r.output, /Example Domain/i);
  },
);
