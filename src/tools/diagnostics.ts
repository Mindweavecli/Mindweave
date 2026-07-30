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

const MAX_WORKING_SET = 3; // when no path given, check the few most-recent files
const MAX_SHOWN = 50;

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  readOnly: true,
  description:
    "Report compiler/linter diagnostics (type errors, syntax errors, warnings) for a " +
    "file from its language server. Call it after editing code to catch problems you " +
    "just introduced and fix them before moving on. Give a `path`, or omit it to check " +
    "the files you edited most recently. Returns nothing when there's no language " +
    "server for the file or no problems are found.",
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

/** The absolute paths to check: the given path, else the recent working set. */
function pickTargets(ctx: ToolContext, rawPath: string): string[] {
  if (rawPath) return [resolvePath(ctx, rawPath)];
  return [...ctx.reads.keys()].slice(-MAX_WORKING_SET);
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
