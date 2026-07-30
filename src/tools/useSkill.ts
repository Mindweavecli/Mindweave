/**
 * useSkill.ts — run one of the project's skills by name.
 *
 * This is the model-driven half of skill invocation (the user-driven half is
 * typing `/name`). Only the skill catalog (name + description + when-to-use) sits
 * in the prompt; when the model decides a skill fits, it calls this tool, which
 * reads the full SKILL.md body from disk and returns it as the result — so the
 * steps enter context only on demand (progressive disclosure). Read-only: it puts
 * instructions in front of the model but changes nothing on disk.
 */
import type { Tool, ToolResult } from "./types.js";
import { findSkill, loadSkillBody, substituteSkillArgs } from "../governor/skills.js";

export const useSkill: Tool = {
  name: "use_skill",
  readOnly: true,
  description:
    "Run one of this project's skills by name and get its full step-by-step " +
    "instructions to follow. The skills you can run are listed under " +
    "available_skills in your context; call this when one fits the task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "The skill's name, exactly as shown in available_skills.",
      },
      arguments: {
        type: "string",
        description:
          "Optional arguments for the skill — substituted into its $ARGUMENTS / $1 placeholders, " +
          "or added as context if it has none.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return fail("`name` is required.");
    const argString = typeof args.arguments === "string" ? args.arguments : "";

    const skills = ctx.governance?.skills ?? [];
    const skill = findSkill(skills, name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(none configured)";
      return fail(`no skill named '${name}'. Available skills: ${available}.`);
    }

    const body = await loadSkillBody(skill);
    if (!body) {
      return fail(`skill '${skill.name}' has no readable SKILL.md.`);
    }

    return {
      output: `Skill "${skill.name}" — follow these steps:\n\n${substituteSkillArgs(body, argString)}`,
      summary: `loaded skill ${skill.name}`,
    };
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
