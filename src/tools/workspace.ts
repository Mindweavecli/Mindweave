/**
 * workspace.ts — add another folder to the session (multi-root).
 *
 * One session usually has a single root, but real work spans repos: a backend and
 * a frontend, an app and a shared library. `add_directory` lets the model honor
 * "also work in ../api" by widening the workspace. Once added, every file tool sees
 * it: reads, searches (grep/glob/list_dir span all roots), and edits, with paths
 * labeled per root so the two never collide. The `/include` command does the same
 * thing by hand. The chassis stays on the primary root; added roots use grep/read.
 */
import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { rootLabel, rootsOf } from "./paths.js";
import { discoverRelatedRoots } from "./workspaceDiscover.js";
import { startChassis, stopChassis } from "../alternator/lane.js";

export const addDirectory: Tool = {
  name: "add_directory",
  readOnly: false,
  description:
    "Add another folder to this session's workspace so you can read, search, and edit " +
    "across it too — e.g. a separate backend, frontend, or shared library. Use it when " +
    "the user asks to add/include a directory, OR when you NOTICE the task spans into a " +
    "folder that isn't in the workspace yet — in that case set `proactive: true` so the " +
    "user is asked to confirm before it's added.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "The folder to add (absolute, or relative to the working directory).",
      },
      proactive: {
        type: "boolean",
        description:
          "Set true when YOU spotted the need (not an explicit user request); the user is " +
          "asked to confirm before the folder is added. Omit for an explicit user request.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    if (!raw) return fail("`path` is required.");
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw);

    // Proactive adds (the model noticed) ask first; explicit requests just add.
    if (args.proactive === true && ctx.requestApproval) {
      if (!(await isDir(abs))) return fail(`directory not found: ${abs}`);
      const choice = await ctx.requestApproval(
        `This work also reaches into '${basename(abs)}' (${abs}), which isn't in the workspace. Include it?`,
        ["Yes, include it", "No, stay in the current folder"],
      );
      if (!choice.startsWith("Yes")) {
        return { output: `Left '${basename(abs)}' out of the workspace at the user's request.`, summary: "kept workspace as-is" };
      }
    }

    const result = await addRoot(ctx, abs);
    if (result.error) return fail(result.error);
    if (result.already) {
      return { output: `'${abs}' is already in the workspace.`, summary: `'${result.label}' already added` };
    }
    return {
      output: `Added '${abs}' to the workspace as '${result.label}'. You can now read/search/edit it; refer to its files as '${result.label}/…'.`,
      summary: `added root '${result.label}'`,
    };
  },
};

export const linkWorkspace: Tool = {
  name: "link_workspace",
  readOnly: false,
  description:
    "Discover and pull in the REST of this project — sibling repos and monorepo members " +
    "(backend, frontend, shared libraries) — so you can work across the whole thing, not " +
    "just one folder. Use it when the task clearly spans the project or the user asks to " +
    "work across the codebase. The user is asked to confirm the folders before they're added.",
  parameters: { type: "object", additionalProperties: false, properties: {} },

  async execute(_args, ctx): Promise<ToolResult> {
    const roots = rootsOf(ctx);
    const related = await discoverRelatedRoots(roots[0]!, roots);
    if (related.length === 0) {
      return { output: "No related project folders found to add (no monorepo config or sibling projects).", summary: "nothing to link" };
    }

    // Ask first (a bulk add) — list what was found.
    if (ctx.requestApproval) {
      const list = related.map((r) => `• ${basename(r.path)} (${r.reason})`).join("\n");
      const choice = await ctx.requestApproval(
        `Found related folders to include in the workspace:\n${list}\nInclude them?`,
        ["Yes, include them", "No"],
      );
      if (!choice.startsWith("Yes")) {
        return { output: "Left the workspace as-is at the user's request.", summary: "link declined" };
      }
    }

    const added: string[] = [];
    for (const r of related) {
      const res = await addRoot(ctx, resolve(r.path));
      if (res.label && !res.already) added.push(res.label);
    }
    if (added.length === 0) return { output: "Those folders were already in the workspace.", summary: "nothing new linked" };
    return {
      output: `Linked ${added.length} folder${added.length === 1 ? "" : "s"} into the workspace: ${added.join(", ")}. You can now read/search/edit across all of them (paths are 'label/…').`,
      summary: `linked ${added.join(", ")}`,
    };
  },
};

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Add `abs` as a root on the tool context (shared, so it takes effect immediately).
 * Validates it's an existing directory. Returns the assigned label, or a reason.
 */
export async function addRoot(
  ctx: ToolContext,
  abs: string,
): Promise<{ label?: string; already?: boolean; error?: string }> {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return { error: `'${abs}' is not a directory.` };
  } catch {
    return { error: `directory not found: ${abs}` };
  }
  const roots = ctx.roots && ctx.roots.length > 0 ? ctx.roots : [ctx.cwd];
  if (roots.includes(abs)) return { already: true, label: rootLabel(roots, abs) };
  ctx.roots = [...roots, abs];
  // Warm a code map for the new root in the background (collision-safe via labels).
  if (!ctx.chassisByRoot) {
    ctx.chassisByRoot = new Map(ctx.chassis ? [[ctx.cwd, ctx.chassis]] : []);
  }
  ctx.chassisByRoot.set(abs, startChassis(abs));
  return { label: rootLabel(ctx.roots, abs) };
}

/** Remove a root by absolute path or by its label. The primary root can't be removed. */
export function removeRoot(ctx: ToolContext, pathOrLabel: string): { removed?: string; error?: string } {
  const roots = rootsOf(ctx);
  if (roots.length <= 1) return { error: "nothing to remove — there's only the primary root." };
  const primary = roots[0]!;
  const match = roots.find(
    (r, i) => i > 0 && (r === pathOrLabel || resolve(r) === resolve(pathOrLabel) || rootLabel(roots, r) === pathOrLabel),
  );
  if (!match) return { error: `no added root matches '${pathOrLabel}'.` };
  const label = rootLabel(roots, match);
  ctx.roots = roots.filter((r) => r !== match);
  if (ctx.roots.length === 1 && ctx.roots[0] === primary) ctx.roots = [primary];
  // Tear down that root's code map (best-effort, in the background).
  const ch = ctx.chassisByRoot?.get(match);
  ctx.chassisByRoot?.delete(match);
  void stopChassis(ch);
  return { removed: label };
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
