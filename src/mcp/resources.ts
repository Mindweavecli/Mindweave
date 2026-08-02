/**
 * resources.ts — the half of MCP that is data rather than actions.
 *
 * A server exposes two kinds of thing. TOOLS are verbs: call one and something happens.
 * RESOURCES are nouns: a schema, a wiki page, a log file, a table — content the agent can
 * read, addressed by URI. v1.3 shipped only the verbs, which meant a server offering a
 * database schema as a resource looked, from inside Mindweave, like a server offering nothing.
 *
 * The load-bearing decision is that resources are NOT modelled as tools. It is tempting —
 * one pseudo-tool per resource would make them show up in the model's tool list for free —
 * and it is wrong, because `tools` is a structural API field rendered before every
 * provider's cache breakpoint (docs/mcp-plan.md §6). A server with 400 resources would
 * then rewrite the cached prefix, and a server whose resource list changes would bust it
 * again. Two fixed tools that go and look cost the same whether there are three resources
 * or three thousand.
 *
 * TEMPLATES are listed alongside, unexpanded. A template like `logs://{date}` is a shape
 * with a hole in it; handing the model a fabricated concrete URI would be inventing data.
 * It sees the shape and fills it in, which is the one thing it is better at than we are.
 *
 * Pure. `connection.ts` fetches, `manager.ts` dispatches.
 */
import type { McpContentBlock } from "./catalog.js";

/** Longest resource description we pass on, mirroring the tool-description cap. */
export const MAX_RESOURCE_DESCRIPTION = 512;

/** How many resources one listing may return, before it is a context problem itself. */
export const MAX_RESOURCES_LISTED = 200;

export interface McpResource {
  server: string;
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceTemplate {
  server: string;
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Does this server say it has resources at all? */
export function hasResources(capabilities: Record<string, unknown>): boolean {
  return Boolean(capabilities?.resources);
}

function text(value: unknown, max = MAX_RESOURCE_DESCRIPTION): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Parse a `resources/list` payload, dropping entries that cannot be used (pure). */
export function parseResourceList(server: string, result: unknown): McpResource[] {
  const raw = (result as { resources?: unknown } | null)?.resources;
  if (!Array.isArray(raw)) return [];
  const out: McpResource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = item as { uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown } | null;
    const uri = typeof r?.uri === "string" ? r.uri.trim() : "";
    // A resource with no URI cannot be read, so it is not a resource.
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({ server, uri, name: text(r?.name, 128) || uri, description: text(r?.description), mimeType: text(r?.mimeType, 64) });
  }
  return sortResources(out);
}

/** Parse a `resources/templates/list` payload (pure). */
export function parseTemplateList(server: string, result: unknown): McpResourceTemplate[] {
  const raw = (result as { resourceTemplates?: unknown } | null)?.resourceTemplates;
  if (!Array.isArray(raw)) return [];
  const out: McpResourceTemplate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = item as { uriTemplate?: unknown; name?: unknown; description?: unknown; mimeType?: unknown } | null;
    const uriTemplate = typeof r?.uriTemplate === "string" ? r.uriTemplate.trim() : "";
    if (!uriTemplate || seen.has(uriTemplate)) continue;
    seen.add(uriTemplate);
    out.push({
      server,
      uriTemplate,
      name: text(r?.name, 128) || uriTemplate,
      description: text(r?.description),
      mimeType: text(r?.mimeType, 64),
    });
  }
  return [...out].sort((a, b) => a.server.localeCompare(b.server) || a.uriTemplate.localeCompare(b.uriTemplate));
}

/** Stable order, for the same reason the tool catalog has one: readable, diffable output. */
export function sortResources(resources: readonly McpResource[]): McpResource[] {
  return [...resources].sort((a, b) => a.server.localeCompare(b.server) || a.uri.localeCompare(b.uri));
}

/**
 * Parse a `resources/read` payload into blocks (pure).
 *
 * Note the shape difference, which is easy to get wrong: `tools/call` returns `content`
 * with typed blocks, while `resources/read` returns `contents` with entries that carry
 * either `text` or `blob` and no `type` at all. Reusing the tool parser here would
 * silently yield nothing.
 */
export function parseResourceRead(result: unknown): McpContentBlock[] {
  const raw = (result as { contents?: unknown } | null)?.contents;
  if (!Array.isArray(raw)) return [];
  const blocks: McpContentBlock[] = [];
  for (const item of raw) {
    const c = item as { uri?: unknown; text?: unknown; blob?: unknown; mimeType?: unknown } | null;
    if (!c || typeof c !== "object") continue;
    const mime = typeof c.mimeType === "string" ? c.mimeType : "";
    if (typeof c.text === "string" && c.text) blocks.push({ kind: "text", text: c.text });
    else if (typeof c.blob === "string" && c.blob) blocks.push({ kind: "binary", mime: mime || "application/octet-stream", base64: c.blob });
  }
  return blocks;
}

/**
 * Render a listing for the model (pure).
 *
 * The URI is what it needs to pass back, so the URI leads. Templates are marked as such
 * and shown with their placeholders intact, because a model that mistakes a template for
 * a real URI will read `logs://{date}` and get an error it cannot interpret.
 */
export function renderResourceList(resources: readonly McpResource[], templates: readonly McpResourceTemplate[]): string {
  const lines: string[] = [];
  if (resources.length > 0) {
    lines.push("Resources (read one with read_mcp_resource):");
    for (const r of resources.slice(0, MAX_RESOURCES_LISTED)) {
      const bits = [r.name !== r.uri ? r.name : "", r.description, r.mimeType].filter(Boolean).join(" — ");
      lines.push(`- [${r.server}] ${r.uri}${bits ? ` — ${bits}` : ""}`);
    }
    if (resources.length > MAX_RESOURCES_LISTED) {
      lines.push(`  … and ${resources.length - MAX_RESOURCES_LISTED} more (narrow with the \`server\` argument).`);
    }
  }
  if (templates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Templates (fill in the {placeholders} to build a URI, then read it):");
    for (const t of templates) {
      const bits = [t.name !== t.uriTemplate ? t.name : "", t.description].filter(Boolean).join(" — ");
      lines.push(`- [${t.server}] ${t.uriTemplate}${bits ? ` — ${bits}` : ""}`);
    }
  }
  return lines.join("\n");
}
