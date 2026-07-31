/**
 * grep.ts — search file contents with a regular expression.
 *
 * Primary engine is ripgrep: precise, fast, .gitignore-aware,
 * and it never loads the project into the agent — only matches come back. When
 * `rg` isn't installed we fall back to a pure-Node walk so search still works.
 *
 * The interface is a familiar, predictable search shape — `pattern`, `path`, `glob`,
 * `output_mode`, `-i`, `context` — so any model can drive it reliably.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isMultiRoot, relativize, rootLabel, rootsOf, searchUnits, type SearchUnit } from "./paths.js";
import { DEFAULT_IGNORES, globToRegExp, walkFiles } from "./walk.js";
import { SEARCH_EXCLUDE_GLOBS, excludedFromSearch } from "./guard.js";
import { ripgrepAvailable, runRipgrep } from "./ripgrep.js";

const MAX_FILES = 5_000;
const MAX_OUTPUT_LINES = 250;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Mode = "files_with_matches" | "content" | "count";

export const grepTool: Tool = {
  name: "grep",
  readOnly: true,
  description:
    "Search file contents with a regular expression. `output_mode` is " +
    "'files_with_matches' (default, just paths), 'content' (matching lines), or " +
    "'count'. Searches every session root unless `path` (a file, directory, or root label) is given.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "The regular expression to search for." },
      path: {
        type: "string",
        description: "File, directory, or root label to search. Defaults to all session roots.",
      },
      glob: {
        type: "string",
        description: 'Only search files whose path matches this glob (e.g. "*.ts").',
      },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        description: "What to return. Defaults to files_with_matches.",
      },
      "-i": { type: "boolean", description: "Case-insensitive search." },
      context: {
        type: "integer",
        minimum: 0,
        description: "Lines of context to show before and after each match (content mode).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) return fail("`pattern` is required.");

    const mode: Mode =
      args.output_mode === "content" || args.output_mode === "count"
        ? args.output_mode
        : "files_with_matches";
    const context = typeof args.context === "number" && args.context > 0 ? Math.floor(args.context) : 0;
    const caseInsensitive = args["-i"] === true;
    const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;

    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const units = searchUnits(ctx, rawPath);
    const haveRg = await ripgrepAvailable();

    // Gather labeled result lines across every root, then format once.
    const lines: string[] = [];
    for (const unit of units) {
      const target = unit.sub ? join(unit.root, unit.sub) : unit.root;
      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        if (rawPath) return fail(`path not found: ${rawPath}`);
        continue; // a missing root in a multi-root sweep is skipped, not fatal
      }
      const o: GrepOpts = { pattern, mode, context, caseInsensitive, glob, ctx, unit, isFile: stat.isFile() };
      const got = haveRg ? await grepViaRipgrep(o) : await grepViaWalk(o);
      if (got.invalid) return fail(got.invalid);
      lines.push(...got.lines);
    }

    return formatGrep(mode, pattern, lines);
  },
};

interface GrepOpts {
  pattern: string;
  mode: Mode;
  context: number;
  caseInsensitive: boolean;
  glob: string | undefined;
  ctx: ToolContext;
  unit: SearchUnit;
  isFile: boolean;
}

/** One unit's labeled output lines, or an `invalid` regex message to surface. */
interface UnitResult {
  lines: string[];
  invalid?: string;
}

/** Combine all roots' labeled lines into the final tool result, capped per mode. */
function formatGrep(mode: Mode, pattern: string, lines: string[]): ToolResult {
  if (lines.length === 0) {
    return { output: "No matches found.", summary: `grep ${pattern} — no matches` };
  }
  if (mode === "content") {
    const capped = lines.slice(0, MAX_OUTPUT_LINES);
    if (lines.length > MAX_OUTPUT_LINES) capped.push("… (more matches — narrow the search)");
    return { output: capped.join("\n"), summary: `grep ${pattern} (${lines.length} line${lines.length === 1 ? "" : "es"})` };
  }
  if (mode === "count") {
    let total = 0;
    for (const line of lines) {
      const n = parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
      if (!isNaN(n)) total += n;
    }
    return { output: lines.join("\n"), summary: `grep ${pattern} (${total} in ${lines.length} files)` };
  }
  const capped = lines.slice(0, 100);
  if (lines.length > 100) capped.push(`… (${lines.length - 100} more — narrow the pattern)`);
  return { output: capped.join("\n"), summary: `grep ${pattern} (${lines.length} file${lines.length === 1 ? "" : "s"})` };
}

// ── ripgrep path (primary) ────────────────────────────────────────────────────
async function grepViaRipgrep(o: GrepOpts): Promise<UnitResult> {
  const args: string[] = ["--hidden", "--path-separator", "/"];
  // Skip the same noise directories the walk does, regardless of .gitignore.
  for (const dir of DEFAULT_IGNORES) args.push("-g", `!${dir}`);
  // `--hidden` above means ripgrep would otherwise descend into dot-directories,
  // which is exactly where secrets and other agents' saved sessions live. Exclude
  // them so a search can't print what a direct read would refuse.
  for (const pattern of SEARCH_EXCLUDE_GLOBS) args.push("-g", `!${pattern}`);

  if (o.caseInsensitive) args.push("-i");
  if (o.mode === "files_with_matches") args.push("-l");
  else if (o.mode === "count") args.push("-c");
  else {
    args.push("-n", "--max-columns", "500");
    if (o.context > 0) args.push("-C", String(o.context));
  }
  if (o.glob) args.push("-g", o.glob);
  args.push("-e", o.pattern);
  // Run FROM the unit's root so emitted paths are root-relative; we label them below.
  args.push("--", o.unit.sub || ".");

  const res = await runRipgrep(args, o.unit.root);

  if (res.code === 2) {
    return { lines: [], invalid: `invalid regular expression or search options: ${res.stderr || o.pattern}` };
  }
  if (res.code !== 0 && res.code !== 1) {
    return grepViaWalk(o); // some other failure — fall back to the pure-Node walk
  }
  // Multi-root: prefix the root label so every path round-trips (a `--` group
  // separator is left alone). Single-root: the lines are already cwd-relative.
  const prefix = isMultiRoot(o.ctx) ? `${rootLabel(rootsOf(o.ctx), o.unit.root)}/` : "";
  const lines = prefix ? res.lines.map((l) => (l === "--" ? l : prefix + l)) : res.lines;
  return { lines };
}

// ── pure-Node walk (fallback when rg is unavailable) ──────────────────────────
async function grepViaWalk(o: GrepOpts): Promise<UnitResult> {
  let regexp: RegExp;
  try {
    regexp = new RegExp(o.pattern, o.caseInsensitive ? "i" : undefined);
  } catch (error) {
    return { lines: [], invalid: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}` };
  }

  const target = o.unit.sub ? join(o.unit.root, o.unit.sub) : o.unit.root;
  let files: { abs: string; rel: string }[];
  if (o.isFile) {
    files = excludedFromSearch(target) ? [] : [{ abs: target, rel: relativize(o.ctx, target) }];
  } else {
    const walked = await walkFiles(target, MAX_FILES);
    // Same exclusions the ripgrep path applies, for the no-ripgrep fallback.
    files = walked.files.filter((f) => !excludedFromSearch(f.abs));
    if (o.glob) {
      const g = globToRegExp(o.glob);
      files = files.filter((f) => g.test(f.rel));
    }
  }

  const out: string[] = [];
  let truncated = false;
  for (const file of files) {
    if (truncated) break;
    let text: string;
    try {
      const buf = await fs.readFile(file.abs);
      if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!regexp.test(lines[i])) continue;
      fileCount++;
      if (o.mode === "content") {
        const lo = Math.max(0, i - o.context);
        const hi = Math.min(lines.length - 1, i + o.context);
        for (let j = lo; j <= hi; j++) {
          out.push(`${relativize(o.ctx, file.abs)}:${j + 1}:${lines[j]}`);
          if (out.length >= MAX_OUTPUT_LINES) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
    if (fileCount > 0 && o.mode === "files_with_matches") out.push(relativize(o.ctx, file.abs));
    if (fileCount > 0 && o.mode === "count") out.push(`${relativize(o.ctx, file.abs)}:${fileCount}`);
  }
  return { lines: out };
}

/** A NUL byte in the first chunk is a cheap, reliable "not text" signal. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
