/**
 * walk.ts — shared filesystem traversal for the discovery tools (glob, grep).
 *
 * Mindweave stays dependency-free, so instead of shelling out to ripgrep/fd we do a
 * plain recursive walk in Node. Two things every walk needs live here so glob
 * and grep behave consistently: a default ignore list (the noise directories no
 * search should ever descend into) and a small glob→RegExp compiler.
 */
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

/** Directories never worth searching — version control and build output. */
export const DEFAULT_IGNORES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/** A file found by the walk: its absolute path and its path relative to root (posix). */
export interface Found {
  abs: string;
  rel: string;
}

/**
 * Recursively list files under `root`, skipping DEFAULT_IGNORES directories.
 * Stops once `limit` files are collected (returns `truncated: true` then). Paths
 * are returned in a stable sorted order so results are deterministic.
 */
export async function walkFiles(
  root: string,
  limit: number,
): Promise<{ files: Found[]; truncated: boolean }> {
  const files: Found[] = [];
  let truncated = false;

  async function descend(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip it rather than fail the whole walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        await descend(full);
      } else if (entry.isFile()) {
        files.push({ abs: full, rel: toPosix(relative(root, full)) });
        if (files.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  }

  await descend(root);
  return { files, truncated };
}

/** Normalize a path to forward slashes for matching and display. */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Compile a glob pattern to an anchored RegExp matched against a posix relative
 * path. Supports `*` (within a segment), `**` (across segments), `?`, and
 * `{a,b}` alternation. A pattern with no `/` is treated as matching anywhere in
 * the tree (e.g. `*.ts` → every `.ts` file), which is the intuitive behaviour.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = toPosix(glob);
  if (!pattern.includes("/")) pattern = `**/${pattern}`;

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = pattern.slice(i + 1, end).split(",");
        re += `(?:${alts.map(escapeRegExp).join("|")})`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
