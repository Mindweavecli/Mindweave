/**
 * mcpAdd.ts — connecting an MCP server by asking for it.
 *
 * Mindweave is a conversation, not a settings pane, so the natural way to add an
 * integration is to say so: "add the github mcp server, my token is in GITHUB_TOKEN".
 * This is the tool that makes that work. `/mcp add` is the same thing for when you
 * already know the exact command; both go through one writer so they cannot drift.
 *
 * ASK-FIRST, always. This writes a config file that spawns a process on every future
 * session, usually with a credential attached. That is squarely in the class of action
 * the approval channel exists for, and it is not something to infer from an ambiguous
 * request. With no channel to ask through it refuses rather than proceeding, matching
 * how every other governed action in the codebase fails.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { addServerToConfig, configPathFor, parseAddSpec, type AddScope } from "../mcp/configWrite.js";

const ADD = "Yes, add it";
const SKIP = "No, don't";

export const addMcpServer: Tool = {
  name: "add_mcp_server",
  readOnly: false,
  description:
    "Connect a new MCP server to this project, so its tools become available to you. " +
    "Use it when the user asks to add an integration ('add the github mcp server', " +
    "'connect to our postgres'). Give either a `command` (with `args`) for a local " +
    "server, or a `url` for a remote one. The user is always asked to confirm first. " +
    "Don't invent credentials — reference an environment variable the user named.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "Short server name; becomes the prefix of its tools (e.g. 'github' → mcp__github__*).",
      },
      command: {
        type: "string",
        description: "Executable for a local server, e.g. 'npx'. Omit if using `url`.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments for the command, e.g. ['-y', '@modelcontextprotocol/server-github'].",
      },
      url: {
        type: "string",
        description: "https:// endpoint for a remote server. Omit if using `command`.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables for a local server, e.g. {\"GITHUB_TOKEN\": \"$GITHUB_TOKEN\"}.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Headers for a remote server, e.g. {\"Authorization\": \"Bearer ...\"}.",
      },
      global: {
        type: "boolean",
        description: "Save for every project instead of just this one. Default false.",
      },
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const spec = specFromArgs(args);
    if (!spec.ok) return { output: `Error: ${spec.error}`, isError: true, summary: "bad server spec" };

    if (!ctx.requestApproval) {
      return {
        output:
          "Error: adding an MCP server needs the user's confirmation and there's no way to ask here. " +
          "Tell them the command to run instead: /mcp add " + spec.display,
        isError: true,
        summary: "cannot ask to add server",
      };
    }

    const choice = await ctx.requestApproval(
      `Add the MCP server '${spec.name}'? It will run ${spec.what} on every session in ` +
        `${spec.scope === "global" ? "every project" : "this project"}, and its tools become available to me.`,
      [ADD, SKIP],
    );
    if (choice !== ADD) {
      return { output: `Not added. '${spec.name}' was not written to any config.`, summary: "declined" };
    }

    const root = ctx.governance?.forbidden.root ?? ctx.cwd;
    const path = configPathFor(spec.scope, root);
    const written = await addServerToConfig(path, spec.parsed).catch((e: unknown) => e as Error);
    if (written instanceof Error) {
      return { output: `Error: couldn't write ${path}: ${written.message}`, isError: true, summary: "write failed" };
    }

    // Connect immediately. Writing the file and saying "restart to use it" would make
    // the whole point of the tool evaporate.
    const status = await ctx.mcp?.addServer(spec.parsed.config);
    const outcome =
      status?.state === "connected"
        ? `connected with ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (protocol ${status.version})`
        : status
          ? `saved, but it is ${status.state}${status.error ? ` — ${status.error}` : ""}`
          : "saved (not started in this context)";

    return {
      output: `${written.replaced ? "Replaced" : "Added"} '${spec.name}' in ${path} — ${outcome}.`,
      summary: `added mcp server '${spec.name}'`,
    };
  },
};

/**
 * Turn the tool's structured arguments into the same spec `/mcp add` produces.
 *
 * Deliberately routed through `parseAddSpec` rather than building a config directly:
 * one validator means the tool cannot accept something the command would reject, or
 * write a shape the loader silently drops.
 */
function specFromArgs(args: Record<string, unknown>):
  | { ok: true; name: string; scope: AddScope; what: string; display: string; parsed: { name: string; scope: AddScope; config: import("../mcp/config.js").McpServerConfig } }
  | { ok: false; error: string } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, error: "`name` is required." };

  const url = typeof args.url === "string" ? args.url.trim() : "";
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!url && !command) return { ok: false, error: "Give either `command` (local server) or `url` (remote server)." };
  if (url && command) return { ok: false, error: "Give `command` OR `url`, not both." };

  const argv: string[] = [];
  if (args.global === true) argv.push("--global");
  if (url) argv.push("--http");
  for (const [k, v] of Object.entries(asStrings(args.headers))) argv.push("--header", `${k}: ${v}`);
  for (const [k, v] of Object.entries(asStrings(args.env))) argv.push("--env", `${k}=${v}`);
  argv.push(name, url || command);
  // `--` so a server's own flags are never read as ours.
  const extra = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
  if (extra.length > 0) argv.push("--", ...extra);

  const parsed = parseAddSpec(argv);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const what = url ? url : [command, ...extra].join(" ");
  return {
    ok: true,
    name,
    scope: parsed.spec.scope,
    what: `\`${what}\``,
    display: `${url ? "--http " : ""}${name} ${what}`,
    parsed: parsed.spec,
  };
}

function asStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}
