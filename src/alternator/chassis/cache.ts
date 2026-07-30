/**
 * cache.ts — persist the built graph so a large repo doesn't re-parse every
 * session.
 *
 * Stored under `~/.mindweave/chassis/<sanitized-project>/graph.json` (next to where
 * sessions live). On startup the lane loads this, then reconciles only the files
 * whose size/mtime changed — so a warm start is near-instant. Best-effort: a
 * missing/corrupt cache just means a full rebuild, never an error.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ref, SymbolNode } from "./types.js";

// v2: symbols carry endLine + doc (nested outlines, doc-comments). An older cache
// is simply ignored and rebuilt, so the new fields are always present.
// v3: the graph now includes HTML/CSS markup symbols + DOM string-link refs, so an
// older cache must rebuild to pick up a project's stylesheets and pages.
const VERSION = 3;

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface ChassisSnapshot {
  version: number;
  manifest: [string, FileStamp][]; // absPath → stamp
  symbols: SymbolNode[];
  refs: [string, Ref[]][]; // name → refs
  imports: [string, string[]][]; // fromFile → imported files
}

function sanitizeProjectPath(root: string): string {
  return root.replace(/[/\\:]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function cachePath(root: string): string {
  return join(homedir(), ".mindweave", "chassis", sanitizeProjectPath(root), "graph.json");
}

/** Load a saved snapshot for `root`, or null if absent/unreadable/stale-version. */
export async function loadCache(root: string): Promise<ChassisSnapshot | null> {
  try {
    const raw = await fs.readFile(cachePath(root), "utf8");
    const snap = JSON.parse(raw) as ChassisSnapshot;
    return snap.version === VERSION ? snap : null;
  } catch {
    return null;
  }
}

/** Write a snapshot for `root`. Best-effort: returns false on any failure. */
export async function saveCache(root: string, snapshot: Omit<ChassisSnapshot, "version">): Promise<boolean> {
  try {
    const path = cachePath(root);
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ version: VERSION, ...snapshot }), "utf8");
    return true;
  } catch {
    return false;
  }
}
