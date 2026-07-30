/**
 * diagnostics.test.ts — the diagnostics tool + its pure formatter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import type { Chassis, CodeDiagnostic } from "../alternator/chassis/types.js";
import { diagnosticsTool, formatDiagnostics } from "./diagnostics.js";

function chassisWith(diags: CodeDiagnostic[]): Chassis {
  return {
    async outline() { return []; },
    async definition() { return { symbols: [], confidence: "name-level" }; },
    async references() { return { refs: [], confidence: "name-level" }; },
    async relevant() { return []; },
    async span() { return []; },
    async directorySummary() { return null; },
    async diagnostics() { return diags; },
    status() { return { ready: true, files: 0, symbols: 0, resolvedLanguages: [] }; },
  };
}

function ctx(chassis: Chassis, reads: string[] = []): ToolContext {
  return { cwd: "/proj", reads: new Map(reads.map((r) => [r, {} as never])), todos: [], chassis };
}

test("formatDiagnostics lists errors before warnings, with location", () => {
  const out = formatDiagnostics([
    { file: "a.ts", line: 10, column: 2, severity: "warning", message: "unused var" },
    { file: "a.ts", line: 3, column: 5, severity: "error", message: "type mismatch", source: "ts" },
  ]);
  const lines = out.split("\n");
  assert.match(lines[0]!, /a\.ts:3:5 error: type mismatch \(ts\)/);
  assert.match(lines[1]!, /a\.ts:10:2 warning: unused var/);
});

test("diagnostics tool reports a file's errors via its chassis", async () => {
  const c = chassisWith([{ file: "/proj/a.ts", line: 3, column: 5, severity: "error", message: "boom" }]);
  const res = await diagnosticsTool.execute({ path: "a.ts" }, ctx(c));
  assert.equal(res.isError, undefined);
  assert.match(res.output, /a\.ts:3:5 error: boom/);
  assert.match(res.summary!, /1 error, 0 warnings/);
});

test("diagnostics tool reports a clean file", async () => {
  const res = await diagnosticsTool.execute({ path: "a.ts" }, ctx(chassisWith([])));
  assert.match(res.output, /No diagnostics/);
});

test("diagnostics tool with no path falls back to the recent working set", async () => {
  const c = chassisWith([{ file: "/proj/b.ts", line: 1, column: 1, severity: "warning", message: "w" }]);
  const res = await diagnosticsTool.execute({}, ctx(c, ["/proj/b.ts"]));
  assert.match(res.output, /b\.ts:1:1 warning: w/);
});
