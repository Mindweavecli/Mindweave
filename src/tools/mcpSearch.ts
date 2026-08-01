/**
 * mcpSearch.ts — the way in to a large MCP catalog.
 *
 * When a project wires up several MCP servers the tool count can run into the hundreds.
 * Showing all of them to the model makes it choose worse, so past a threshold they are
 * held back and this tool is the door: search, and what matches becomes callable.
 *
 * Registered as an ordinary built-in, so it is always present and costs one tool's worth
 * of schema rather than a catalog's worth. It is inert (and says so) when there is
 * nothing deferred, which is the common case — most projects have a handful of servers
 * and see every tool directly.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { renderResults } from "../mcp/deferred.js";

export const findMcpTools: Tool = {
  name: "find_mcp_tools",
  readOnly: true,
  description:
    "Search the MCP tools available in this project that aren't already loaded, and load " +
    "the matches so you can call them. Use it whenever a task needs an external " +
    "integration you can't already see a tool for (issue trackers, databases, cloud " +
    "APIs, docs systems). Query with a server name ('github'), an action ('create " +
    "issue', 'search'), or a tool name if you know it. Loaded tools stay available for " +
    "the rest of the session, so search once per capability, not once per call.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "What you need: a server name, an action, or an exact tool name.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { output: "Error: `query` is required.", isError: true, summary: "no query" };

    const mcp = ctx.mcp;
    const snapshot = mcp?.snapshot();
    if (!mcp || !snapshot || snapshot.toolCount === 0) {
      return {
        output:
          "No MCP servers are connected in this project, so there are no external tools to find. " +
          "Use your built-in tools.",
        summary: "no mcp servers",
      };
    }

    // Under the deferral threshold nothing is hidden. Say so plainly rather than
    // returning results that are already in the tool list — a model that searches here
    // and gets a list back may reasonably conclude it had to.
    if (!snapshot.deferred) {
      return {
        output:
          `All ${snapshot.toolCount} MCP tool${snapshot.toolCount === 1 ? " is" : "s are"} already loaded and visible in ` +
          `your tool list — nothing is hidden, so you don't need this tool here. Call the one you want directly.`,
        summary: "nothing deferred",
      };
    }

    const found = mcp.searchAndActivate(query);
    if (found.length === 0) {
      return {
        output:
          `No MCP tool matches "${query}". There ${snapshot.toolCount === 1 ? "is" : "are"} ${snapshot.toolCount} ` +
          `available in total — try a broader term, or a server name on its own. If nothing fits, this project ` +
          `has no integration for that and you should solve it another way rather than guessing a tool name.`,
        summary: `no match for "${query}"`,
      };
    }

    return {
      output:
        `Loaded ${found.length} tool${found.length === 1 ? "" : "s"} — you can call ${found.length === 1 ? "it" : "them"} now:\n\n` +
        `${renderResults(found)}`,
      summary: `loaded ${found.length} tool${found.length === 1 ? "" : "s"}`,
    };
  },
};
