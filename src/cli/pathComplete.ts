/**
 * pathComplete.ts — file completion for the `@mention` picker.
 *
 * Given what's been typed after `@` (e.g. `src/co`), list matching files and
 * folders under the project root, shell-style: split off the directory part,
 * match the trailing fragment against that directory's entries, return full
 * relative paths (folders keep a trailing `/` so you can keep drilling in).
 * Scoped to the primary root — dragging a file still handles any other path.
 */
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_IGNORES } from "../tools/walk.js";

const MAX_RESULTS = 12;

export async function completePath(cwd: string, prefix: string): Promise<string[]> {
  const norm = prefix.split("\\").join("/");
  const slash = norm.lastIndexOf("/");
  const dirPart = slash >= 0 ? norm.slice(0, slash) : "";
  const fragment = (slash >= 0 ? norm.slice(slash + 1) : norm).toLowerCase();

  let entries;
  try {
    entries = await fs.readdir(resolve(cwd, dirPart), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.name.toLowerCase().startsWith(fragment))
    .filter((e) => !(e.isDirectory() && DEFAULT_IGNORES.has(e.name)))
    // Hide dotfiles unless the user is explicitly typing a dot.
    .filter((e) => !e.name.startsWith(".") || fragment.startsWith("."))
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    })
    .slice(0, MAX_RESULTS)
    .map((e) => (dirPart ? `${dirPart}/` : "") + e.name + (e.isDirectory() ? "/" : ""));
}
