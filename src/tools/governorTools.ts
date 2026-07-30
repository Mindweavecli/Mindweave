/**
 * governorTools.ts — the model's hands on the governor: make a rule, forbid a path.
 *
 * These let natural language work: "make it a rule to use pnpm" → remember_rule;
 * "never touch src/legacy" → forbid_path. Each persists the change to the
 * project's state dir (so it survives restarts and applies in every future
 * session here) AND mirrors it into the live `ctx.governance` so it takes effect
 * this turn — a new rule is injected next prompt, a new forbidden path is enforced
 * by edit/write/run immediately. Deciding WHAT to make a rule/forbid is the
 * user's call relayed by the model; these tools only record it.
 */
import type { Tool, ToolResult } from "./types.js";
import { writeRule, appendForbidden, appendForbiddenCommand, deriveRuleName, writeSkill } from "../governor/write.js";
import { parseGlobs } from "../governor/rules.js";

/** The project root for state files: the fixed session root, carried on the
 *  governance config (cwd may have moved via `cd`; the root never does). */
function projectRoot(ctx: { cwd: string; governance?: { forbidden: { root: string } } }): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

export const rememberRule: Tool = {
  name: "remember_rule",
  readOnly: false,
  description:
    "Save a standing rule for THIS project — a directive to follow here (e.g. " +
    "'use pnpm, never npm'). It persists across sessions. By default it's always " +
    "in effect; pass `globs` to scope it so it only applies when working on " +
    "matching files (e.g. globs 'src/api/**' for a rule about API routes). Use it " +
    "when the user says to make something a rule.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["rule"],
    properties: {
      rule: {
        type: "string",
        description: "The rule, imperative and self-contained (e.g. 'Use pnpm, never npm').",
      },
      name: {
        type: "string",
        description: "Optional short name for the rule; one is derived from the text if omitted.",
      },
      globs: {
        type: "string",
        description:
          "Optional comma-separated path globs that scope the rule to matching files " +
          "(e.g. 'src/api/**, src/routes/**'). Omit for an always-on rule.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const body = typeof args.rule === "string" ? args.rule.trim() : "";
    if (!body) return fail("`rule` is required.");
    const name = (typeof args.name === "string" && args.name.trim()) || deriveRuleName(body);
    const globs = parseGlobs(typeof args.globs === "string" ? args.globs : undefined);

    const saved = await writeRule(projectRoot(ctx), name, body, "", globs);
    // Mirror into the live session so the rule is in the very next prompt.
    if (ctx.governance) {
      ctx.governance.rules = [
        ...ctx.governance.rules.filter((r) => r.name !== saved.name),
        saved,
      ];
    }
    const scope = globs.length > 0 ? ` (scoped to ${globs.join(", ")})` : "";
    return {
      output: `Saved rule '${saved.name}'${scope}. It now applies to this project (this session and future ones).`,
      summary: `saved rule '${saved.name}'`,
    };
  },
};

export const forbidPath: Tool = {
  name: "forbid_path",
  readOnly: false,
  description:
    "Forbid a path in THIS project — a file, folder, or glob (relative to the " +
    "project root) you must never modify or run a command against. It's enforced " +
    "by the tools and persists across sessions. Use it when the user forbids " +
    "touching something. e.g. 'src/legacy/**', 'config/prod.json'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "Path glob relative to the project root (e.g. 'src/legacy/**' or 'deploy.sh').",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return fail("`pattern` is required.");

    const result = await appendForbidden(projectRoot(ctx), pattern);
    if (!result.pattern) return fail("the pattern is empty after normalization.");

    // Mirror into the live forbidden config (new array → matcher recompiles).
    if (ctx.governance && result.added) {
      ctx.governance.forbidden = {
        ...ctx.governance.forbidden,
        patterns: [...ctx.governance.forbidden.patterns, result.pattern],
      };
    }
    return {
      output: result.added
        ? `Forbidden '${result.pattern}'. I won't modify it or run commands against it.`
        : `'${result.pattern}' was already forbidden.`,
      summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
    };
  },
};

export const forbidCommand: Tool = {
  name: "forbid_command",
  readOnly: false,
  description:
    "Forbid a command in THIS project — a command or command fragment you must " +
    "NEVER run (e.g. 'tauri dev', 'git push', 'npm run deploy'). run_command " +
    "refuses any command containing it, and it persists across sessions. Use it " +
    "when the user says never to run something, or to stop reopening/redeploying. " +
    "Match is a case-insensitive substring, so keep the pattern specific.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "The command or fragment to forbid (e.g. 'tauri dev', 'git push --force').",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return fail("`pattern` is required.");

    const result = await appendForbiddenCommand(projectRoot(ctx), pattern);
    if (!result.pattern) return fail("the pattern is empty after normalization.");

    // Mirror into the live forbidden config (new array → enforced this turn on).
    if (ctx.governance && result.added) {
      ctx.governance.forbidden = {
        ...ctx.governance.forbidden,
        commands: [...(ctx.governance.forbidden.commands ?? []), result.pattern],
      };
    }
    return {
      output: result.added
        ? `Forbidden the command '${result.pattern}'. I won't run it (or anything containing it) unless you lift it.`
        : `'${result.pattern}' was already forbidden.`,
      summary: result.added ? `forbade command '${result.pattern}'` : `'${result.pattern}' already forbidden`,
    };
  },
};

export const createSkill: Tool = {
  name: "create_skill",
  readOnly: false,
  description:
    "Create a reusable skill for THIS project — a named, step-by-step procedure " +
    "you (or the user via /name) can run later. Use it when the user says to make/" +
    "save a skill, or to capture a multi-step workflow worth reusing. Write `steps` " +
    "as a clear markdown checklist. It persists across sessions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "steps"],
    properties: {
      name: {
        type: "string",
        description: "Short invocation name, e.g. 'release' (becomes /release).",
      },
      description: {
        type: "string",
        description: "One line on what the skill does — shown in the catalog and used to pick it.",
      },
      steps: {
        type: "string",
        description:
          "The skill body: the procedure as markdown. May use $ARGUMENTS or $1/$2 placeholders " +
          "for arguments passed at invocation.",
      },
      when_to_use: {
        type: "string",
        description: "Optional: when you should reach for this skill.",
      },
      argument_hint: {
        type: "string",
        description: "Optional usage hint for arguments, e.g. '<env>' for /release <env>.",
      },
      globs: {
        type: "string",
        description:
          "Optional comma-separated globs that scope the skill's catalog visibility to matching " +
          "files (it stays invokable by name regardless).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const body = typeof args.steps === "string" ? args.steps.trim() : "";
    if (!name) return fail("`name` is required.");
    if (!body) return fail("`steps` is required — the skill needs a body.");

    const saved = await writeSkill(projectRoot(ctx), {
      name,
      description,
      body,
      whenToUse: typeof args.when_to_use === "string" ? args.when_to_use.trim() : "",
      argumentHint: typeof args.argument_hint === "string" ? args.argument_hint.trim() : "",
      globs: parseGlobs(typeof args.globs === "string" ? args.globs : undefined),
    });
    // Mirror into the live catalog so it can be used immediately.
    if (ctx.governance) {
      ctx.governance.skills = [
        ...ctx.governance.skills.filter((s) => s.name !== saved.name),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      output: `Created skill '${saved.name}'. Run it with /${saved.name} or call use_skill.`,
      summary: `created skill '${saved.name}'`,
    };
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
