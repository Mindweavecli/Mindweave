/**
 * listDir.ts — list the entries of one directory.
 *
 * The quickest way for the model to get its bearings: what's in this folder?
 * Read-only, single level (use glob for a recursive search). Directories are
 * marked with a trailing slash so the model can tell them from files at a glance.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isMultiRoot, relativize, searchUnits, type SearchUnit } from "./paths.js";
import { DEFAULT_IGNORES } from "./walk.js";

const MAX_ENTRIES = 400;

export const listDir: Tool = {
  name: "list_dir",
  readOnly: true,
  description:
    "List the immediate contents of a directory (one level, not recursive). " +
    "Directories are shown with a trailing slash. Defaults to every session root.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Directory (or a root's label) to list. Defaults to every session root.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const units = searchUnits(ctx, rawPath);
    const multi = isMultiRoot(ctx) && !rawPath; // group with headers when sweeping roots

    const blocks: string[] = [];
    let total = 0;
    for (const unit of units) {
      const dir = unit.sub ? join(unit.root, unit.sub) : unit.root;
      const listed = await listOne(ctx, dir, unit);
      if (!listed) {
        if (rawPath) return fail(`directory not found: ${rawPath}`);
        continue;
      }
      total += listed.count;
      blocks.push(multi ? `${relativize(ctx, dir)}/\n${indent(listed.body)}` : listed.body);
    }

    if (blocks.length === 0) return fail(`directory not found: ${rawPath ?? "."}`);
    return {
      output: blocks.join("\n\n"),
      summary: `list ${units.length > 1 ? `${units.length} roots` : relativize(ctx, units[0]!.sub ? join(units[0]!.root, units[0]!.sub) : units[0]!.root)} (${total} item${total === 1 ? "" : "s"})`,
    };
  },
};

/** List one directory's immediate entries (dirs first), or null if unreadable. */
async function listOne(ctx: ToolContext, dir: string, _unit: SearchUnit): Promise<{ body: string; count: number } | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });

  const truncated = entries.length > MAX_ENTRIES;
  const shown = entries.slice(0, MAX_ENTRIES).map((e) => {
    const noisy = e.isDirectory() && DEFAULT_IGNORES.has(e.name);
    return e.isDirectory() ? `${e.name}/${noisy ? "  (skipped by search)" : ""}` : e.name;
  });
  if (shown.length === 0) return { body: "(empty directory)", count: 0 };
  if (truncated) shown.push(`… (${entries.length - MAX_ENTRIES} more)`);
  return { body: shown.join("\n"), count: entries.length };
}

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
