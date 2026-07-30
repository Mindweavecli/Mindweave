/**
 * markdown.test.ts — the terminal markdown renderer.
 *
 * ANSI styling is terminal-dependent, so we assert on the ANSI-stripped content:
 * markup markers are gone, entities are decoded, lists/headings/code render as
 * readable text. (Whether a span is bold/cyan is a visual detail we don't pin.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.js";

const ESC = String.fromCharCode(27);
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

test("inline bold/italic/code render without their literal markers", () => {
  assert.equal(strip(renderMarkdown("**bold** and *em* and `code`")), "bold and em and code");
});

test("HTML entities are decoded back to characters", () => {
  assert.equal(strip(renderMarkdown(`a & b's "c" < d`)), `a & b's "c" < d`);
});

test("ordered and unordered lists render with numbers / bullets", () => {
  const ordered = strip(renderMarkdown("1. one\n2. two"));
  assert.match(ordered, /1\. one/);
  assert.match(ordered, /2\. two/);
  assert.match(strip(renderMarkdown("- a\n- b")), /• a/);
});

test("headings drop the # and code fences drop the backticks", () => {
  const heading = strip(renderMarkdown("# Title"));
  assert.match(heading, /Title/);
  assert.doesNotMatch(heading, /#/);
  const code = strip(renderMarkdown("```\nx = 1\n```"));
  assert.doesNotMatch(code, /```/);
  assert.match(code, /x = 1/);
});

test("a link shows its text and url", () => {
  const out = strip(renderMarkdown("[the docs](https://mindweave.dev)"));
  assert.match(out, /the docs/);
  assert.match(out, /https:\/\/mindweave\.dev/);
});

test("plain text passes through unchanged", () => {
  assert.equal(strip(renderMarkdown("just a sentence.")), "just a sentence.");
});

test("a wide table is wrapped to fit the width — no line overflows", () => {
  const md = [
    "| Page | File | Key features |",
    "| --- | --- | --- |",
    "| Book Detail | book-detail.html | Dynamic single-book view via ?book= query param, reserve button with 3s visual feedback, Not Found fallback, and a related books section |",
    "| Home | home.html | Hero banner, book-type cards, author grid, community features, visit info |",
  ].join("\n");
  const width = 60;
  const lines = strip(renderMarkdown(md, width)).split("\n");
  for (const line of lines) {
    assert.ok(line.length <= width, `line exceeds width ${width} (${line.length}): ${JSON.stringify(line)}`);
  }
  // The content is still all there, just wrapped across lines (drop the box
  // borders and collapse whitespace to check the words survived the wrap).
  const flat = strip(renderMarkdown(md, width)).replace(/[│─┼├┤]/g, " ").replace(/\s+/g, " ");
  assert.match(flat, /Key features/);
  assert.match(flat, /related books section/);
  assert.match(flat, /book-detail\.html/);
});

test("a narrow table still fits and stays a grid", () => {
  const md = "| A | B |\n| --- | --- |\n| one two three four five | six |";
  const width = 24;
  for (const line of strip(renderMarkdown(md, width)).split("\n")) {
    assert.ok(line.length <= width, `overflow: ${line.length} > ${width}`);
  }
});

test("a table renders airy — no outer box border, one header rule", () => {
  const md = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |";
  const lines = strip(renderMarkdown(md, 40)).split("\n");
  // No line is wrapped in an outer box: rows never start or end with a border bar.
  for (const line of lines) {
    assert.doesNotMatch(line, /^│/, `row should not open with an outer border: ${JSON.stringify(line)}`);
    assert.doesNotMatch(line, /│\s*$/, `row should not close with an outer border: ${JSON.stringify(line)}`);
  }
  // Exactly one horizontal rule (under the header), not a grid line per row.
  const ruleLines = lines.filter((l) => /^─+$/.test(l.trim()));
  assert.equal(ruleLines.length, 1, "expected a single header rule, not per-row separators");
});
