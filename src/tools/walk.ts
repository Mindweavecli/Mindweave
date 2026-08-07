/**
 * walk.ts — shared filesystem traversal for the discovery tools (glob, grep).
 *
 * Mindweave stays dependency-free, so instead of shelling out to ripgrep/fd we do a
 * plain recursive walk in Node. Three things every walk needs live here so glob
 * and grep behave consistently: a default ignore list (the noise directories no
 * search should ever descend into), .gitignore handling that matches what ripgrep
 * does (see gitignore.ts for why), and a small glob→RegExp compiler.
 */
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { isIgnored, loadIgnoreLayer, type IgnoreLayer } from "./gitignore.js";

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

export interface WalkOptions {
  /**
   * Honour .gitignore files, the way ripgrep does (default true). This exists so
   * the two search engines agree: `rg` is gitignore-aware, and before this the Node
   * fallback was not, so the same query answered differently depending on whether
   * `rg` happened to be installed. Pass false for a walk that must see everything
   * regardless of ignore rules.
   */
  gitignore?: boolean;
}

/**
 * Recursively list files under `root`, skipping DEFAULT_IGNORES directories and
 * (by default) anything the project's .gitignore files exclude.
 * Stops once `limit` files are collected (returns `truncated: true` then). Paths
 * are returned in a stable sorted order so results are deterministic.
 *
 * SYMLINKS ARE NOT FOLLOWED, deliberately. A symlinked directory reports neither
 * `isDirectory()` nor `isFile()`, so it used to fall through both branches and get
 * dropped without anyone deciding that. It is now an explicit skip, for two
 * reasons: ripgrep does not follow symlinks by default either (so the engines
 * agree, which is the whole point of the gitignore work above), and Mindweave
 * already has a first-class way to search code that lives elsewhere — add it as a
 * root with `/link` or `add_directory`, which labels it and indexes it properly
 * instead of silently splicing another tree into this one's relative paths.
 */
export async function walkFiles(
  root: string,
  limit: number,
  opts: WalkOptions = {},
): Promise<{ files: Found[]; truncated: boolean }> {
  const files: Found[] = [];
  let truncated = false;
  const useGitignore = opts.gitignore !== false;

  async function descend(dir: string, layers: IgnoreLayer[]): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip it rather than fail the whole walk
    }

    // A .gitignore in this directory applies to it and everything below.
    let stack = layers;
    if (useGitignore && entries.some((e) => e.name === ".gitignore" && !e.isDirectory())) {
      const layer = await loadIgnoreLayer(dir);
      if (layer) stack = [...layers, layer];
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue; // symlink / socket / device — see header
      if (isDir && DEFAULT_IGNORES.has(entry.name)) continue;
      if (stack.length && ignoredBy(stack, full, isDir)) continue;
      if (isDir) {
        await descend(full, stack);
      } else {
        files.push({ abs: full, rel: toPosix(relative(root, full)) });
        if (files.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  }

  await descend(root, []);
  return { files, truncated };
}

/** Test an absolute path against the active .gitignore layers. */
function ignoredBy(stack: readonly IgnoreLayer[], abs: string, isDir: boolean): boolean {
  return isIgnored(
    stack.map((layer) => ({ layer, rel: toPosix(relative(layer.base, abs)) })),
    isDir,
  );
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
