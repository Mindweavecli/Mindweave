/**
 * workspace.ts — add another folder to the session (multi-root).
 *
 * One session usually has a single root, but real work spans repos: a backend and
 * a frontend, an app and a shared library. `add_directory` lets the model honor
 * "also work in ../api" by widening the workspace. Once added, every file tool sees
 * it: reads, searches (grep/glob/list_dir span all roots), and edits, with paths
 * labeled per root so the two never collide. The `/include` command does the same
 * thing by hand.
 *
 * Each root gets its OWN code map, started in the background by `addRoot` and torn
 * down by `removeRoot` (`chassisByRoot`). This comment used to say the chassis stayed
 * on the primary root and added roots fell back to grep — that stopped being true when
 * per-root chassis landed, and it described the tool as weaker than it is.
 */
import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { canonicalRoot, rootLabel, rootsOf } from "./paths.js";
import { discoverRelatedRoots } from "./workspaceDiscover.js";
import { startChassis, stopChassis } from "../alternator/lane.js";

export const addDirectory: Tool = {
  name: "add_directory",
  readOnly: false,
  // What was missing is what happens AFTER: paths in a second root are label-prefixed,
  // and a model that does not know that reads the new folder's files as if they sat
  // under the primary root. The proactive branch also has a real refusal now (no
  // channel to ask through), which the model has to be able to act on.
  description:
    "Add another folder to this session's workspace so you can read, search and edit " +
    "across it too: a separate backend, a frontend, a shared library. Use it when the " +
    "user asks to include a directory, or when you NOTICE the task reaching into a " +
    "folder that is not in the workspace yet — in that case set `proactive: true`, " +
    "which asks the user first. A proactive add can come back refused, either because " +
    "they declined or because there was no way to ask; that is an answer, not an error " +
    "to retry, so carry on within the folders you already have.\n" +
    "Once added, the folder gets a LABEL and its files are addressed as `label/…` in " +
    "every tool — that is how two roots holding `src/index.ts` stay distinct. The " +
    "result tells you the label; use it from then on. Adding a folder that is already " +
    "in the workspace is harmless and simply says so, including when it was added " +
    "under a different spelling or through a symlink.",
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
    if (args.proactive === true) {
      if (!(await isDir(abs))) return fail(`directory not found: ${abs}`);
      // With no way to ask, a proactive add must NOT happen. The old guard folded the
      // missing channel into the condition, so exactly the case that needed consent
      // silently proceeded without it — and that is the case a sub-agent is in.
      if (!ctx.requestApproval) {
        return {
          output:
            `Did not add '${basename(abs)}' to the workspace: widening it needs the user's ` +
            `agreement and there is no way to ask from here. Work within the current roots, ` +
            `and if you genuinely need that folder, say so in your result.`,
          summary: "cannot ask to widen workspace",
        };
      }
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
  // "The user is asked to confirm" was unconditionally true in the text and
  // conditionally true in the code. It is now unconditional in both.
  description:
    "Discover and pull in the REST of this project — sibling repos and monorepo " +
    "members, a backend beside a frontend, shared libraries — so you can work across " +
    "the whole thing rather than one folder of it. Use it when the task clearly spans " +
    "the project, or the user asks to work across the codebase. Prefer add_directory " +
    "when you already know the one folder you need; this is the wide, find-everything " +
    "option.\n" +
    "It finds folders by their project files (workspace members, sibling projects), " +
    "not by guessing, so it can legitimately find nothing. The user confirms the whole " +
    "set before anything is added, and if there is no way to ask, nothing is added and " +
    "you are told what was found — report that rather than trying again. Added folders " +
    "are addressed by label as `label/…`, and the result names each one.",
  parameters: { type: "object", additionalProperties: false, properties: {} },

  async execute(_args, ctx): Promise<ToolResult> {
    const roots = rootsOf(ctx);
    const related = await discoverRelatedRoots(roots[0]!, roots);
    if (related.length === 0) {
      return { output: "No related project folders found to add (no monorepo config or sibling projects).", summary: "nothing to link" };
    }

    // Ask first (a bulk add) — list what was found. With no way to ask, do NOT proceed:
    // this is the widest change either tool can make, and the old `if (requestApproval)`
    // meant the absence of consent was treated as consent. A sub-agent is exactly that
    // case, so this could silently pull in every sibling repo on the machine.
    if (!ctx.requestApproval) {
      return {
        output:
          `Found ${related.length} related folder${related.length === 1 ? "" : "s"}, but adding ` +
          `${related.length === 1 ? "it" : "them"} needs the user's agreement and there is no way ` +
          `to ask from here. Name them in your result and let the user decide: ` +
          `${related.map((r) => basename(r.path)).join(", ")}.`,
        summary: "cannot ask to link workspace",
      };
    }
    const list = related.map((r) => `• ${basename(r.path)} (${r.reason})`).join("\n");
    const choice = await ctx.requestApproval(
      `Found related folders to include in the workspace:\n${list}\nInclude them?`,
      ["Yes, include them", "No"],
    );
    if (!choice.startsWith("Yes")) {
      return { output: "Left the workspace as-is at the user's request.", summary: "link declined" };
    }

    const added: string[] = [];
    const failed: string[] = [];
    for (const r of related) {
      const res = await addRoot(ctx, resolve(r.path));
      if (res.error) failed.push(basename(r.path));
      else if (res.label && !res.already) added.push(res.label);
    }
    // A folder that was discovered but could not be added has to be named. Reporting
    // only the successes let a partial link read as a complete one.
    const note = failed.length > 0 ? ` Could not add ${failed.join(", ")}.` : "";
    if (added.length === 0) {
      return {
        output: `No new folders were linked.${note || " Those folders were already in the workspace."}`,
        summary: failed.length > 0 ? `linked nothing, ${failed.length} failed` : "nothing new linked",
      };
    }
    return {
      output:
        `Linked ${added.length} folder${added.length === 1 ? "" : "s"} into the workspace: ` +
        `${added.join(", ")}. You can now read/search/edit across all of them (paths are 'label/…').${note}`,
      summary: `linked ${added.join(", ")}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`,
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
  requested: string,
): Promise<{ label?: string; already?: boolean; error?: string }> {
  // Canonicalise, exactly as the PRIMARY root does on the way in. This was the one
  // entry point that skipped it, and `paths.ts` states the invariant plainly: every
  // root goes through this once so the session speaks one form of every path.
  // Without it the dedup below is a raw string compare, so the SAME directory could
  // be added repeatedly under different spellings — measured: `RealApi`, `realapi`
  // and a junction pointing at it all became separate roots with separate labels, so
  // every search walked that tree three times and reported each hit three ways.
  const abs = await canonicalRoot(requested);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return { error: `'${abs}' is not a directory.` };
  } catch {
    return { error: `directory not found: ${requested}` };
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
  const match = roots.find(
    (r, i) => i > 0 && (r === pathOrLabel || resolve(r) === resolve(pathOrLabel) || rootLabel(roots, r) === pathOrLabel),
  );
  if (!match) return { error: `no added root matches '${pathOrLabel}'.` };
  const label = rootLabel(roots, match);
  ctx.roots = roots.filter((r) => r !== match);
  // Tear down that root's code map (best-effort, in the background).
  const ch = ctx.chassisByRoot?.get(match);
  ctx.chassisByRoot?.delete(match);
  void stopChassis(ch);
  return { removed: label };
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
