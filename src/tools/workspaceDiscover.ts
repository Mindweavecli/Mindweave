/**
 * workspaceDiscover.ts — find the rest of the project to pull into the workspace.
 *
 * "This is only part of the work" — given the primary root, discover the related
 * folders so the model can work across the whole thing. Two sources, in order:
 *   1. Monorepo declarations — package.json `workspaces`, pnpm-workspace.yaml,
 *      lerna.json, go.work, Cargo `[workspace] members`. Precise: the project
 *      itself says what its parts are.
 *   2. Sibling projects — if no monorepo config, the sibling folders next to the
 *      root that look like code projects (have package.json / .git / go.mod / …).
 *
 * Pure discovery: it only reads and returns candidates; adding them is the caller's
 * job (so /link and the model tool can apply their own confirmation policy).
 */
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RelatedRoot {
  path: string; // absolute
  reason: string; // why it was suggested (shown to the user)
}

/** Markers that say "this folder is a project worth including." */
const PROJECT_MARKERS = [
  "package.json",
  ".git",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "tsconfig.json",
];

/**
 * Discover folders related to `root` that aren't already in `existing`. Monorepo
 * members win; siblings are the fallback when there's no workspace config.
 */
export async function discoverRelatedRoots(root: string, existing: readonly string[]): Promise<RelatedRoot[]> {
  const found = new Map<string, string>(); // abs path → reason

  // 1a. package.json workspaces (array, or { packages: [...] }).
  const pkg = await readJson(join(root, "package.json"));
  const wsPatterns: string[] = [];
  const ws = (pkg as { workspaces?: unknown })?.workspaces;
  if (Array.isArray(ws)) wsPatterns.push(...ws.filter((x): x is string => typeof x === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    wsPatterns.push(...((ws as { packages: unknown[] }).packages.filter((x): x is string => typeof x === "string")));
  }

  // 1b. pnpm + lerna patterns.
  const pnpm = await readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm) wsPatterns.push(...parseYamlPackages(pnpm));
  const lerna = await readJson(join(root, "lerna.json"));
  if (Array.isArray((lerna as { packages?: unknown })?.packages)) {
    wsPatterns.push(...((lerna as { packages: unknown[] }).packages.filter((x): x is string => typeof x === "string")));
  }
  for (const pattern of wsPatterns) {
    for (const dir of await expandPattern(root, pattern)) found.set(dir, "workspace member");
  }

  // 1c. go.work modules.
  const gowork = await readText(join(root, "go.work"));
  if (gowork) {
    for (const use of parseGoWork(gowork)) {
      const abs = resolve(root, use);
      if (await isDir(abs)) found.set(abs, "go.work module");
    }
  }

  // 1d. Cargo workspace members.
  const cargo = await readText(join(root, "Cargo.toml"));
  if (cargo) {
    for (const member of parseCargoMembers(cargo)) {
      for (const dir of await expandPattern(root, member)) found.set(dir, "cargo member");
    }
  }

  // 2. Siblings — only when nothing was declared.
  if (found.size === 0) {
    for (const sib of await siblingProjects(root)) found.set(sib, "sibling project");
  }

  const skip = new Set(existing.map((r) => resolve(r)));
  skip.add(resolve(root));
  return [...found]
    .filter(([abs]) => !skip.has(resolve(abs)))
    .map(([path, reason]) => ({ path, reason }));
}

// ── glob expansion ───────────────────────────────────────────────────────────
/** Expand one workspace pattern (`packages/*`, `apps/web`, …) to absolute dirs. */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const norm = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const star = norm.indexOf("*");
  if (star === -1) {
    const abs = resolve(root, norm);
    return (await isDir(abs)) ? [abs] : [];
  }
  // One glob level: the dirs directly under the part before the `*`.
  const base = norm.slice(0, star).replace(/\/+$/, "");
  const baseAbs = resolve(root, base);
  let entries;
  try {
    entries = await fs.readdir(baseAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => join(baseAbs, e.name));
}

// ── siblings ─────────────────────────────────────────────────────────────────
async function siblingProjects(root: string): Promise<string[]> {
  const parent = dirname(root);
  if (parent === root) return [];
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = join(parent, e.name);
    if (resolve(abs) === resolve(root)) continue;
    if (await looksLikeProject(abs)) out.push(abs);
  }
  return out;
}

async function looksLikeProject(dir: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await exists(join(dir, marker))) return true;
  }
  return false;
}

// ── tiny parsers ─────────────────────────────────────────────────────────────
/** The `packages:` list from pnpm-workspace.yaml (no YAML dependency). */
function parseYamlPackages(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\s*packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
    if (m) out.push(m[1]!.trim());
    else if (/^\S/.test(line)) break; // dedented to a new top-level key
  }
  return out;
}

/** `use` directives from go.work (single lines and the `use ( … )` block). */
function parseGoWork(text: string): string[] {
  const out = new Set<string>();
  const block = text.match(/use\s*\(([^)]*)\)/s);
  if (block) for (const l of block[1]!.split("\n")) {
    const t = l.trim();
    if (t && !t.startsWith("//")) out.add(t);
  }
  for (const m of text.matchAll(/^\s*use\s+(\S+)\s*$/gm)) out.add(m[1]!);
  return [...out];
}

/** `members = [ … ]` from a Cargo `[workspace]`. */
function parseCargoMembers(text: string): string[] {
  const m = text.match(/members\s*=\s*\[([^\]]*)\]/s);
  if (!m) return [];
  return [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
}

// ── fs helpers ───────────────────────────────────────────────────────────────
async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}
async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
