/**
 * domRefs.test.ts — the pure DOM class/id reference extractor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDomRefs } from "./domRefs.js";

const names = (code: string) => extractDomRefs(code).map((r) => r.name).sort();

test("extracts ids and classes from the common DOM APIs", () => {
  const code = [
    `const a = document.getElementById("hero");`,
    `const b = root.querySelector(".hero-stats");`,
    `document.querySelectorAll("#nav");`,
    `el.classList.add("active");`,
    `document.getElementsByClassName("card");`,
  ].join("\n");
  assert.deepEqual(names(code), ["active", "card", "hero", "hero-stats", "nav"].sort());
});

test("strips the leading . / # from selector strings", () => {
  assert.deepEqual(names(`querySelector('.foo'); getElementById('#bar');`), ["bar", "foo"]);
});

test("ignores ordinary strings that aren't DOM selector calls", () => {
  assert.deepEqual(names(`const x = "hello"; log("world"); fetch("/api/users");`), []);
});

test("reports 1-based lines, shifted by the offset", () => {
  const refs = extractDomRefs(`\ndocument.getElementById("x");`, 10);
  assert.equal(refs[0]!.name, "x");
  assert.equal(refs[0]!.line, 12); // line 2 in the snippet + offset 10
});
