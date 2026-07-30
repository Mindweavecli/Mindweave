/**
 * codeIntel.ts — the read-only tools that query the chassis (Mindweave's code map).
 *
 * These give the model IDE-grade navigation — outline, jump-to-definition,
 * find-references, and a relevance map — without reading or grepping blindly.
 * They query `ctx.chassis` (built by the alternator lane) and fall back to a
 * clear "use grep/read" message when it isn't available. Every result carries
 * the chassis's confidence: `name-level` answers tell the model to verify with
 * grep when exact identity matters (the assistant-not-authority rule).
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize, resolvePath } from "./paths.js";
import { allChassis, chassisForPath, mergedDefinition, mergedReferences, mergedRelevant } from "./chassisMux.js";
import { walkFiles } from "./walk.js";
import { isSupported } from "../alternator/chassis/treesitter.js";
import { isMarkupSupported } from "../alternator/chassis/markup.js";
import type { Confidence, DirectorySummary, OutlineEntry } from "../alternator/chassis/types.js";

const DIR_FILE_CAP = 40;
const REF_CAP = 100;

function indexingNote(ctx: ToolContext): string {
  return ctx.chassis?.status().ready ? "" : " (code map still indexing — may be incomplete)";
}

function caveat(confidence: Confidence): string {
  return confidence === "name-level"
    ? "\n(name-level match — verify with grep if exact identity matters)"
    : "";
}

export const outlineTool: Tool = {
  name: "outline",
  readOnly: true,
  description:
    "Show the structural outline of a file (its symbols + signatures, no bodies) " +
    "or, for a directory, the outline of each file under it. Fast way to grasp " +
    "shape without reading whole files. Works on HTML/CSS too: it lists a page's " +
    "sections/ids and a stylesheet's selectors with line numbers — use it to navigate " +
    "a big page instead of reading it top to bottom.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "File or directory. Defaults to the working directory." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    const abs = resolvePath(ctx, rawPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return fail(`path not found: ${rawPath}`);
    }

    const groups: { file: string; entries: readonly OutlineEntry[] }[] = [];
    let rollup = "";
    if (stat.isFile()) {
      const entries = await (chassisForPath(ctx, abs)?.outline(abs) ?? Promise.resolve([]));
      groups.push({ file: abs, entries });
    } else {
      // A directory: lead with a folder rollup (counts, central symbols, deps).
      const summary = await chassisForPath(ctx, abs)?.directorySummary(abs);
      if (summary) rollup = renderDirSummary(ctx, summary);
      const { files } = await walkFiles(abs, 5000);
      const supported = files.filter((f) => isSupported(f.abs) || isMarkupSupported(f.abs)).slice(0, DIR_FILE_CAP);
      for (const f of supported) {
        const entries = (await chassisForPath(ctx, f.abs)?.outline(f.abs)) ?? [];
        if (entries.length) groups.push({ file: f.abs, entries });
      }
    }

    const outlineBody = groups
      .map((g) => {
        const header = relativize(ctx, g.file);
        return `${header}\n${renderOutlineEntries(g.entries).join("\n")}`;
      })
      .join("\n\n");
    const body = [rollup, outlineBody].filter(Boolean).join("\n\n");

    if (!body) return { output: `No symbols found in ${rawPath}.${indexingNote(ctx)}`, summary: `outline ${rawPath} (empty)` };
    return { output: body + indexingNote(ctx), summary: `outline ${rawPath} (${groups.length} file${groups.length === 1 ? "" : "s"})` };
  },
};

export const definitionTool: Tool = {
  name: "definition",
  readOnly: true,
  description:
    "Find where a symbol (function, class, type, …) is defined, by name. Covers " +
    "HTML/CSS too: pass a CSS class or id (e.g. \"hero-stats\") to jump to its style " +
    "rule, or an element id to find that section — the exact file:line, no reading.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", description: "The symbol name to locate." } },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return fail("`name` is required.");

    const { symbols, confidence } = await mergedDefinition(ctx, name);
    if (symbols.length === 0) {
      return { output: `No definition of '${name}' in the code map.${indexingNote(ctx)} Try grep.`, summary: `definition ${name} — none` };
    }
    const body = symbols
      .map((s) => `${relativize(ctx, s.file)}:${s.line}  ${s.kind} ${s.signature ?? s.name}`)
      .join("\n");
    return { output: body + caveat(confidence) + indexingNote(ctx), summary: `definition ${name} (${symbols.length})` };
  },
};

export const referencesTool: Tool = {
  name: "references",
  readOnly: true,
  description:
    "Find where a symbol is referenced (used), by name. For a CSS class or id, this " +
    "returns every HTML element and every script (getElementById/querySelector/" +
    "classList) that uses it — the cross-language blast radius before you change a style.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", description: "The symbol name to find references to." } },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return fail("`name` is required.");

    const { refs, confidence } = await mergedReferences(ctx, name);
    if (refs.length === 0) {
      return { output: `No references to '${name}' in the code map.${indexingNote(ctx)} Try grep.`, summary: `references ${name} — none` };
    }
    const shown = refs.slice(0, REF_CAP).map((r) => `${relativize(ctx, r.file)}:${r.line}`);
    if (refs.length > REF_CAP) shown.push(`… (${refs.length - REF_CAP} more)`);
    return { output: shown.join("\n") + caveat(confidence) + indexingNote(ctx), summary: `references ${name} (${refs.length})` };
  },
};

export const relevantTool: Tool = {
  name: "relevant",
  readOnly: true,
  description:
    "Show the code most relevant right now — symbols ranked by how central they are " +
    "to the files you're working on. Good for orienting in an unfamiliar area.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Focus file/dir. Defaults to the files you've recently read." },
      limit: { type: "integer", minimum: 1, description: "Max symbols to return (default 25)." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const focus =
      typeof args.path === "string" && args.path.trim()
        ? [resolvePath(ctx, args.path.trim())]
        : [...ctx.reads.keys()].slice(-5);
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 25;

    const ranked = await mergedRelevant(ctx, focus, limit);
    if (ranked.length === 0) {
      return { output: `The code map has nothing to rank yet.${indexingNote(ctx)}`, summary: "relevant — none" };
    }
    const body = ranked
      .map((r) => `${relativize(ctx, r.symbol.file)}:${r.symbol.line}  ${r.symbol.kind} ${r.symbol.name}`)
      .join("\n");
    return { output: body + indexingNote(ctx), summary: `relevant (${ranked.length})` };
  },
};

/** Render a directory rollup: counts, its most central symbols, and folder deps. */
function renderDirSummary(ctx: ToolContext, s: DirectorySummary): string {
  const where = relativize(ctx, s.dir);
  const lines = [`${where}/ — ${s.files} file${s.files === 1 ? "" : "s"}, ${s.symbols} symbol${s.symbols === 1 ? "" : "s"}`];
  if (s.topSymbols.length) {
    lines.push(`  central: ${s.topSymbols.slice(0, 8).map((sym) => `${sym.name} (${sym.kind})`).join(", ")}`);
  }
  if (s.dependsOn.length) {
    lines.push(`  depends on: ${s.dependsOn.map((d) => `${relativize(ctx, d)}/`).join(", ")}`);
  }
  return lines.join("\n");
}

/** Render a nested outline: indent by depth, show each symbol's doc when present. */
function renderOutlineEntries(entries: readonly OutlineEntry[], depth = 0): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const indent = "  ".repeat(depth);
    const doc = e.doc ? `  — ${e.doc}` : "";
    out.push(`  ${String(e.line).padStart(4)}  ${indent}${e.kind} ${e.name}${doc}`);
    if (e.children?.length) out.push(...renderOutlineEntries(e.children, depth + 1));
  }
  return out;
}

function degraded(): ToolResult {
  return {
    output: "The code map isn't available here — use grep, glob, and read_file instead.",
    summary: "code map unavailable",
  };
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
