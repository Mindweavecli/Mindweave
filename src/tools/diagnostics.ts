/**
 * diagnostics.ts — surface compiler/linter errors from the language servers.
 *
 * Mindweave already runs language servers (for def/ref); this reads their *diagnostics*
 * — the type errors, syntax errors, and warnings they publish — so the model can
 * check what it just wrote and fix it, instead of editing blind. Rather than running
 * diagnostics automatically after every edit, here it's an explicit tool the model calls
 * after changing code, plus prompt guidance to do so.
 *
 * Read-only: it only reads what the servers report. Degrade-safe: no server for the
 * language (or none reported) → a clean "no diagnostics" result.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { CodeDiagnostic } from "../alternator/chassis/types.js";
import { chassisForPath } from "./chassisMux.js";
import { relativize, resolvePath } from "./paths.js";
import { selectActiveFiles } from "../memory/workingSet.js";

/** When no path is given, check this many of the most-recently-touched files.
 *  Exported so the number quoted in the description is pinned to the real value. */
export const MAX_WORKING_SET = 3;
const MAX_SHOWN = 50;

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  readOnly: true,
  // Written against the failure this tool is supposed to PREVENT: the model edits,
  // asks for diagnostics, is told "no diagnostics", and moves on with broken code.
  // Three things made that possible and none of them were in the text — the check is
  // per-file so a broken CALLER is never seen, a clean answer is not proof (no server,
  // a slow server, and an unreadable path all render identically), and the no-path
  // form only reaches a few files.
  description:
    "Report compiler and linter diagnostics (type errors, syntax errors, warnings) for " +
    "a file, from its language server. It re-syncs the file from disk first, so it " +
    "reflects what you actually just wrote, not a stale copy. Call it after editing " +
    "code, and fix what it reports before moving on.\n" +
    "SCOPE: it checks the FILES YOU NAME and nothing else. Diagnostics are per-file, " +
    `so if you omit path it checks only the ${MAX_WORKING_SET} files you touched most ` +
    "recently. A change that breaks code elsewhere — you renamed a symbol, changed a " +
    "signature, altered an exported type — will NOT show up here, because the broken " +
    "file is the CALLER. After that kind of edit, find the callers with `references` " +
    "and check those paths too.\n" +
    "A clean result is weaker evidence than it looks: you also get \"no diagnostics\" " +
    "when no language server handles that file type, when the server is too slow to " +
    "answer, and when the path does not exist or cannot be read. So it confirms " +
    "problems, it does not prove their absence. Treat a clean answer on code you " +
    "expected to be broken as a reason to check the path and verify another way " +
    "(build it, run the tests) rather than as a passing grade.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File to check. Omit to check the most recently read/edited files.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const targets = pickTargets(ctx, typeof args.path === "string" ? args.path.trim() : "");
    if (targets.length === 0) {
      return { output: "No file to check — edit or read a file first, or pass a `path`.", summary: "no target" };
    }

    const results = await Promise.all(
      targets.map(async (abs) => {
        const chassis = chassisForPath(ctx, abs);
        const diags = chassis ? await chassis.diagnostics(abs) : [];
        return { abs, diags };
      }),
    );

    const all: CodeDiagnostic[] = [];
    for (const r of results) all.push(...r.diags);
    if (all.length === 0) {
      const label = targets.map((t) => relativize(ctx, t)).join(", ");
      return { output: `No diagnostics for ${label}.`, summary: "no diagnostics" };
    }

    const output = formatDiagnostics(all.map((d) => ({ ...d, file: relativize(ctx, d.file) })));
    const errors = all.filter((d) => d.severity === "error").length;
    const warnings = all.filter((d) => d.severity === "warning").length;
    return { output, summary: `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}` };
  },
};

/**
 * The absolute paths to check: the given path, else the most recently touched files.
 *
 * This used to read `reads.keys()` in Map order, which is INSERTION order — and
 * `reads.set()` on a key that already exists does not move it. So a file read early
 * and edited last kept its original position and fell outside the window, and the tool
 * answered "No diagnostics" for files it had never looked at while the file just
 * edited was broken. `touchedAt` is the recency stamp that survives a re-touch, and
 * `selectActiveFiles` is the same ordering the working set already uses.
 */
function pickTargets(ctx: ToolContext, rawPath: string): string[] {
  if (rawPath) return [resolvePath(ctx, rawPath)];
  return selectActiveFiles(ctx.reads, MAX_WORKING_SET).map((f) => f.path);
}

/** Render diagnostics as `file:line:col severity: message`, errors first. Pure. */
export function formatDiagnostics(diags: CodeDiagnostic[]): string {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  const sorted = [...diags].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const shown = sorted.slice(0, MAX_SHOWN);
  const lines = shown.map(
    (d) => `${d.file}:${d.line}:${d.column} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ""}`,
  );
  if (sorted.length > shown.length) lines.push(`… (${sorted.length - shown.length} more)`);
  return lines.join("\n");
}
