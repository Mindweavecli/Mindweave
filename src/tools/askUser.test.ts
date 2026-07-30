/**
 * askUser.test.ts — the ask_user clarification tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { askUserTool } from "./askUser.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/proj", reads: new Map(), todos: [], ...over };
}

test("ask_user returns the user's choice via the approval channel", async () => {
  const asked: { q: string; o: string[] }[] = [];
  const res = await askUserTool.execute(
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    ctx({
      requestApproval: async (q, o) => {
        asked.push({ q, o });
        return "SQLite";
      },
    }),
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /The user chose: SQLite/);
  assert.deepEqual(asked, [{ q: "Which database?", o: ["Postgres", "SQLite"] }]);
});

test("ask_user without an approval channel tells the model to proceed on a default", async () => {
  const res = await askUserTool.execute(
    { question: "Which?", options: ["A", "B"] },
    ctx(),
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /best judgment|default/i);
});

test("ask_user requires a question and at least two options", async () => {
  assert.equal((await askUserTool.execute({ question: "", options: ["A", "B"] }, ctx())).isError, true);
  assert.equal((await askUserTool.execute({ question: "Q", options: ["only one"] }, ctx())).isError, true);
});
