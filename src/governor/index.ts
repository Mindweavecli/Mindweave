/**
 * governor — the per-project control layer (rules · skills · forbidden).
 *
 * Like an engine's governor regulates how it may run, this regulates how Mindweave
 * works inside a project: the standing rules it must follow, the skills it can
 * run, and the paths/actions it must never touch. Everything is scoped to one
 * project and stored under that project's state dir (`~/.mindweave/projects/<proj>/`),
 * the same place sessions live — so a rule set in project A never leaks into B.
 * (Global rules/skills are a planned second layer; the per-project design leaves
 * a clean seam for merging one on top.)
 *
 * `loadGovernance` reads it all once at session start (cheap: a couple of small
 * directory reads). The forbidden config rides on the tool context for
 * mechanical enforcement; the rules and skill catalog are rendered into the
 * system prompt by the engine.
 */
import { projectDir } from "../memory/store.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadRules } from "./rules.js";
import { loadSkillCatalog } from "./skills.js";
import { parseForbidden, parseForbiddenCommands } from "./forbidden.js";
import type { Governance } from "./types.js";

/** Read a project state file (forbidden.md / forbidden-commands.md), "" if absent. */
async function readStateFile(stateDir: string, name: string): Promise<string> {
  try {
    return await fs.readFile(join(stateDir, name), "utf8");
  } catch {
    return "";
  }
}

/** Load all governance for the project rooted at `cwd`. Always succeeds (empties). */
export async function loadGovernance(cwd: string): Promise<Governance> {
  const stateDir = projectDir(cwd);
  const [rules, skills, forbiddenText, forbiddenCmdText] = await Promise.all([
    loadRules(stateDir),
    loadSkillCatalog(stateDir),
    readStateFile(stateDir, "forbidden.md"),
    readStateFile(stateDir, "forbidden-commands.md"),
  ]);
  return {
    rules,
    skills,
    forbidden: {
      patterns: parseForbidden(forbiddenText),
      commands: parseForbiddenCommands(forbiddenCmdText),
      root: cwd,
    },
  };
}

export { renderRules } from "./rules.js";
export { renderSkillCatalog } from "./skills.js";
export type { Governance, Rule, SkillMeta, ForbiddenConfig } from "./types.js";
