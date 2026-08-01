/**
 * config.ts — which MCP servers to connect to.
 *
 * Servers are declared in `mcp.json`, global (`~/.mindweave/mcp.json`) and/or
 * per-project (`<cwd>/.mindweave/mcp.json`), with the project file overriding by name.
 * Two transports are configurable: a local `stdio` command, or a remote `http` URL.
 *
 * The parse is PURE and defensive throughout: a malformed file, a bad entry, an entry
 * of an unknown type — all dropped, never thrown. A broken config degrades to "no MCP"
 * rather than taking the session with it, because the alternative is a user who cannot
 * start the agent at all until they fix a JSON file.
 *
 * Shape, matching what the ecosystem already writes so an existing config just works:
 *
 *   {
 *     "mcpServers": {
 *       "fs":     { "command": "npx", "args": ["-y", "@x/server-fs"], "env": {...} },
 *       "remote": { "type": "http", "url": "https://…", "headers": {...} },
 *       "off":    { "command": "…", "disabled": true }
 *     }
 *   }
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpStdioConfig {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpHttpConfig {
  type: "http";
  name: string;
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** Where a project's MCP config lives. */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".mindweave", "mcp.json");
}

/** Where the user-wide MCP config lives. */
export function globalConfigPath(): string {
  return join(homedir(), ".mindweave", "mcp.json");
}

/** Load configs from the global and project files (project wins by name). */
export async function loadMcpConfig(cwd: string): Promise<McpServerConfig[]> {
  const [global, project] = await Promise.all([readConfigFile(globalConfigPath()), readConfigFile(projectConfigPath(cwd))]);
  const byName = new Map<string, McpServerConfig>();
  for (const s of [...global, ...project]) byName.set(s.name, s);
  return [...byName.values()];
}

async function readConfigFile(path: string): Promise<McpServerConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return []; // no file → no servers, quietly
  }
  return parseMcpConfig(raw);
}

/**
 * Pure parse of an mcp.json body into validated configs.
 *
 * `mcpServers` is the key the ecosystem settled on; `servers` is accepted too because
 * both appear in the wild and rejecting one would look like the file being ignored.
 */
export function parseMcpConfig(raw: string): McpServerConfig[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = data as { mcpServers?: unknown; servers?: unknown } | null;
  const servers = root?.mcpServers ?? root?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];

  const out: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = parseEntry(name.trim(), value);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** One entry → a config, or null if it cannot be used. */
export function parseEntry(name: string, value: unknown): McpServerConfig | null {
  if (!name) return null;
  const s = value as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; disabled?: unknown } | null;
  if (!s || typeof s !== "object") return null;
  const disabled = s.disabled === true;

  // An explicit type wins; otherwise infer from which field is present, which is how
  // every config in the wild is actually written.
  const declared = typeof s.type === "string" ? s.type.toLowerCase() : "";
  const isHttp = declared === "http" || declared === "streamable-http" || (!declared && typeof s.url === "string");

  if (isHttp) {
    const url = typeof s.url === "string" ? s.url.trim() : "";
    // Only http(s). A `file://` or arbitrary scheme here would be a way to point the
    // client at something that is not an MCP endpoint at all.
    if (!/^https?:\/\//i.test(url)) return null;
    const headers = sanitizeStrings(s.headers);
    return { type: "http", name, url, ...(headers ? { headers } : {}), ...(disabled ? { disabled } : {}) };
  }

  // Anything else is a local command. `sse` and `ws` are deliberately unsupported:
  // HTTP+SSE was deprecated in 2025-03-26 and its sunset has passed.
  if (declared && declared !== "stdio") return null;
  const command = typeof s.command === "string" ? s.command.trim() : "";
  if (!command) return null;
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
  const env = sanitizeStrings(s.env);
  return { type: "stdio", name, command, args, ...(env ? { env } : {}), ...(disabled ? { disabled } : {}) };
}

function sanitizeStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}
