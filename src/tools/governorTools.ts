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
import { isMcpToolName } from "../mcp/catalog.js";
import { writeRule, appendForbidden, appendForbiddenCommand, appendForbiddenMcpTool, deriveRuleName, slugify, writeSkill } from "../governor/write.js";
import { parseGlobs } from "../governor/rules.js";

/** The project root for state files: the fixed session root, carried on the
 *  governance config (cwd may have moved via `cd`; the root never does). */
function projectRoot(ctx: { cwd: string; governance?: { forbidden: { root: string } } }): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

export const rememberRule: Tool = {
  name: "remember_rule",
  readOnly: false,
  // A rule costs prompt space on EVERY turn for the life of the project, and that
  // was nowhere in the text — so the thing the model most needs to weigh was absent.
  description:
    "Save a standing rule for THIS project: a directive to follow here, such as 'use " +
    "pnpm, never npm'. It persists across sessions. Use it when the user says to make " +
    "something a rule, or clearly states a durable preference about how work is done " +
    "here — not for a one-off instruction that applies to the task in hand.\n" +
    "An always-on rule is injected into your context every single turn from now on, so " +
    "prefer few, sharp rules over many. If it only matters for certain files, pass " +
    "`globs` ('src/api/**') and it will be injected only when the work touches them.\n" +
    "Write it as a standing instruction, not a note about now: 'Use pnpm, never npm', " +
    "not 'the user said to use pnpm'. Re-saving under a name that reduces to the same " +
    "slug REPLACES the earlier rule, so reuse the name to revise one and choose a " +
    "clearly different name for a new one.",
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
    //
    // Deduplicate by SLUG, not by the display name. The rule FILE is `<slug>.md`, so
    // "Use pnpm" and "use pnpm!" are one rule on disk and were two in memory: the
    // session showed both, the next session showed one, and the user watched a rule
    // they had just set disappear on restart. Matching how the file is keyed is what
    // keeps the live list and the disk agreeing.
    if (ctx.governance) {
      const slug = slugify(saved.name);
      ctx.governance.rules = [
        ...ctx.governance.rules.filter((r) => slugify(r.name) !== slug),
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
  // Sharpened on the one distinction that decides whether the model reaches for this
  // tool or the wrong one: forbidding is about WRITING, not about seeing.
  description:
    "Forbid a path in THIS project: a file, folder or glob, relative to the project " +
    "root, that must never be MODIFIED or used as the target of a command. Enforced by " +
    "the tools themselves and persists across sessions. Use it when the user says not " +
    "to touch something — 'src/legacy/**', 'config/prod.json'.\n" +
    "This protects against changes, not against reading: a forbidden path can still be " +
    "read and searched, which is deliberate, because understanding code you must not " +
    "edit is normal and often the point. Secrets are a separate matter and are already " +
    "refused everywhere without any rule being set.\n" +
    "Adding the same pattern twice is harmless and says so. A forbidden path is not a " +
    "dead end when the task genuinely needs it: the attempt asks the user, who can lift " +
    "it for the session.",
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
  // The matcher is a plain substring, which cuts both ways, and only one of those
  // ways was stated. Over-broad patterns are the failure mode here.
  description:
    "Forbid a command in THIS project: a command or fragment that must NEVER be run, " +
    "such as 'tauri dev', 'git push', 'npm run deploy'. run_command then refuses any " +
    "command containing it, and it persists across sessions. Use it when the user says " +
    "never to run something, or to stop you reopening or redeploying their app.\n" +
    "The match is a case-insensitive substring, with runs of whitespace treated as one " +
    "space, so 'git  push' still matches 'git push'. Being a substring, a short pattern " +
    "catches far more than it looks like: 'push' would block 'git push', but also " +
    "'npm run push-check' and any command with that word anywhere in it. Forbid the " +
    "specific command the user meant, not a word from it.",
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

export const forbidMcpTool: Tool = {
  name: "forbid_mcp_tool",
  readOnly: false,
  description:
    "Forbid one MCP tool in THIS project by its full name, e.g. " +
    "'mcp__github__delete_repo'. It stops being offered and stops being callable, from " +
    "the next step onward rather than the next session, and stays that way across " +
    "sessions — without disabling the rest of that server. Use it when the user says " +
    "one specific external action is off-limits.\n" +
    "It must be the full `mcp__server__tool` name exactly as it appears in your tool " +
    "list; a bare tool name is rejected rather than written down, because a name that " +
    "matches nothing would look like a ban that quietly did nothing. A forbidden tool " +
    "also disappears from find_mcp_tools, so searching will not bring it back.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "The full MCP tool name, as it appears in your tool list (mcp__server__tool).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return fail("`name` is required.");
    // Guarding the shape matters: a bare tool name would be written to disk, never
    // match anything, and look like the ban silently failed.
    if (!isMcpToolName(name)) {
      return fail(`'${name}' is not an MCP tool name. Use the full name from your tool list, e.g. 'mcp__github__create_issue'.`);
    }

    const result = await appendForbiddenMcpTool(projectRoot(ctx), name);
    if (!result.pattern) return fail("the name is empty after normalization.");

    // Mirror into the live config AND the live pool, so the ban takes effect on the
    // next step rather than the next session.
    if (ctx.governance && result.added) {
      ctx.governance.forbidden = {
        ...ctx.governance.forbidden,
        mcpTools: [...(ctx.governance.forbidden.mcpTools ?? []), result.pattern],
      };
      ctx.mcp?.setForbidden(ctx.governance.forbidden.mcpTools ?? []);
    }
    return {
      output: result.added
        ? `Forbidden the MCP tool '${result.pattern}'. It's no longer available to me unless you lift it.`
        : `'${result.pattern}' was already forbidden.`,
      summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
    };
  },
};

export const createSkill: Tool = {
  name: "create_skill",
  readOnly: false,
  // Two things the model could not have known: the name is normalised (so the
  // invocation it announces may not be the name it passed), and creating over an
  // existing name destroys that skill.
  description:
    "Create a reusable skill for THIS project: a named, step-by-step procedure that " +
    "you or the user (via /name) can run later. Use it when the user says to save a " +
    "skill, or to capture a multi-step workflow clearly worth repeating. It persists " +
    "across sessions.\n" +
    "Unlike a rule, a skill is CHEAP to keep: only its name and description sit in " +
    "your context, and the steps are loaded only when it runs. So prefer a skill for " +
    "anything procedural, and a rule only for something that must colour every turn.\n" +
    "The name is normalised to lowercase-with-dashes, so 'Release Process' becomes " +
    "/release-process — the result tells you the real invocation. Creating one under a " +
    "name that normalises to an existing skill REPLACES it, with no warning, so check " +
    "available_skills first if you are unsure. Write `steps` as a clear markdown " +
    "checklist for someone starting cold, and use $ARGUMENTS or $1…$9 where the " +
    "procedure needs input.",
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
