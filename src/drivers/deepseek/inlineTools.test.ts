/**
 * inlineTools.test.ts — recovering tool calls DeepSeek leaks into the text stream
 * as DSML markup, and stripping that markup from the visible reply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasInlineToolCalls, parseInlineToolCalls, stripInlineToolCalls } from "./inlineTools.js";

// The exact shape seen in the wild (fullwidth pipe delimiters around "DSML").
const LEAK =
  'Here you go.\n' +
  '<｜｜DSML｜｜tool_calls>\n' +
  '<｜｜DSML｜｜invoke name="todo_write">\n' +
  '<｜｜DSML｜｜parameter name="todos" string="false">[{"content":"Create contact.html","activeForm":"Creating contact.html","status":"completed"}]</｜｜DSML｜｜parameter>\n' +
  '</｜｜DSML｜｜invoke>\n' +
  '</｜｜DSML｜｜tool_calls>';

test("detects a leaked tool-call block", () => {
  assert.equal(hasInlineToolCalls(LEAK), true);
  assert.equal(hasInlineToolCalls("just a normal reply"), false);
});

test("strips the markup, leaving the real reply text", () => {
  assert.equal(stripInlineToolCalls(LEAK), "Here you go.");
  assert.equal(stripInlineToolCalls("plain"), "plain");
});

test("parses the leaked block into a real tool call with JSON args", () => {
  const { cleaned, toolCalls } = parseInlineToolCalls(LEAK);
  assert.equal(cleaned, "Here you go.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.name, "todo_write");
  const args = JSON.parse(toolCalls[0]!.arguments) as { todos: { status: string; content: string }[] };
  assert.equal(args.todos[0]!.status, "completed");
  assert.equal(args.todos[0]!.content, "Create contact.html");
});

test("a string parameter (not string=\"false\") stays a literal string", () => {
  const block =
    '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_file">' +
    '<｜｜DSML｜｜parameter name="path">src/app.ts</｜｜DSML｜｜parameter>' +
    '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
  const { toolCalls } = parseInlineToolCalls(block);
  const args = JSON.parse(toolCalls[0]!.arguments) as { path: string };
  assert.equal(args.path, "src/app.ts");
});

test("normal content is untouched", () => {
  const text = "Both callers hit refresh(). I gated it behind one promise.";
  assert.equal(stripInlineToolCalls(text), text);
  assert.deepEqual(parseInlineToolCalls(text), { cleaned: text, toolCalls: [] });
});
