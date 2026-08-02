/**
 * mcpResources.ts — reaching an MCP server's data, as opposed to its actions.
 *
 * Two built-ins, not one tool per resource. The reasoning is in `mcp/resources.ts` and it
 * is worth repeating here because the tempting design is the wrong one: a pseudo-tool per
 * resource would sit in the `tools` array, which every provider renders before its cache
 * breakpoint, so a server with a large or moving resource list would rewrite the cached
 * prompt prefix. These two schemas cost the same whether the project has three resources
 * or three thousand.
 *
 * They are inert and say so when nothing offers resources, in the same way
 * `find_mcp_tools` does — a model that calls a tool and gets an empty answer with no
 * explanation tends to assume it did something wrong and try again.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { renderResourceList } from "../mcp/resources.js";

export const listMcpResources: Tool = {
  name: "list_mcp_resources",
  readOnly: true,
  description:
    "List the data resources exposed by this project's MCP servers — schemas, documents, " +
    "logs, tables and the like, addressed by URI. Use it when a task needs reference " +
    "material an integration holds rather than an action it performs, and before guessing " +
    "at a resource URI. Read one afterwards with read_mcp_resource.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      server: {
        type: "string",
        description: "Only list this server's resources. Omit to list every server's.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const mcp = ctx.mcp;
    if (!mcp) return { output: "No MCP servers are connected in this project.", summary: "no mcp servers" };

    const server = typeof args.server === "string" ? args.server.trim() : "";
    const offering = mcp.resourceServers();
    if (offering.length === 0) {
      return {
        output:
          "No connected MCP server exposes resources in this project. Use your built-in tools to find " +
          "what you need on disk, or check /mcp for the servers that are connected.",
        summary: "no resources",
      };
    }
    if (server && !offering.some((s) => s === server || s.replace(/[^a-zA-Z0-9_-]/g, "_") === server)) {
      return {
        output: `No connected server named '${server}' exposes resources. These do: ${offering.join(", ")}.`,
        isError: true,
        summary: `no resources on ${server}`,
      };
    }

    const { resources, templates } = await mcp.listResources(server || undefined);
    if (resources.length === 0 && templates.length === 0) {
      return {
        output: `${server || "The connected servers"} advertise resources but returned none right now.`,
        summary: "no resources listed",
      };
    }
    return {
      output: renderResourceList(resources, templates),
      summary: `${resources.length} resource${resources.length === 1 ? "" : "s"}${templates.length ? ` + ${templates.length} template${templates.length === 1 ? "" : "s"}` : ""}`,
    };
  },
};

export const readMcpResource: Tool = {
  name: "read_mcp_resource",
  readOnly: true,
  description:
    "Read one resource from an MCP server by its URI. Get the URI from list_mcp_resources " +
    "first — or build it from a template by filling in the {placeholders}. Large or binary " +
    "resources are saved to a file and you get the path instead of the contents.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["server", "uri"],
    properties: {
      server: {
        type: "string",
        description: "Which server holds it, as shown in brackets by list_mcp_resources.",
      },
      uri: {
        type: "string",
        description: "The resource URI, e.g. 'postgres://db/schema' or 'file:///notes.md'.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const mcp = ctx.mcp;
    if (!mcp) return { output: "No MCP servers are connected in this project.", isError: true, summary: "no mcp servers" };

    const server = typeof args.server === "string" ? args.server.trim() : "";
    const uri = typeof args.uri === "string" ? args.uri.trim() : "";
    if (!server || !uri) {
      return { output: "Error: both `server` and `uri` are required.", isError: true, summary: "missing arguments" };
    }
    // A template still holding its placeholders would be sent to the server verbatim and
    // come back as an unhelpful not-found. Say what is actually wrong instead.
    if (/\{[^}]+\}/.test(uri)) {
      return {
        output:
          `'${uri}' is a template, not a resource URI — the {placeholders} have to be filled in first. ` +
          `If you don't know what to put in them, list the resources and see whether a concrete one already exists.`,
        isError: true,
        summary: "unfilled template",
      };
    }

    const { text, isError } = await mcp.readResource(server, uri);
    return { output: text, ...(isError ? { isError: true } : {}), summary: isError ? `failed: ${uri}` : `read ${uri}` };
  },
};
