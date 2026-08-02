/**
 * prompts.ts — a server's own canned instructions, offered as slash commands.
 *
 * The third thing an MCP server can expose. A tool is something the agent decides to
 * call; a PROMPT is something the USER picks — "summarise this PR", "write the release
 * notes the way we write them" — authored by whoever wrote the server and invoked
 * deliberately. The spec is explicit that prompts are user-initiated, which settles where
 * they belong in the UI: they are slash commands, not tools. Advertising them as tools
 * would also put them in the cached prefix, and they are the least deserving thing there
 * — the model does not choose them.
 *
 * That lands them on a seam this codebase already has. Project skills are already listed
 * alongside the built-in commands and, when run, push a user message and take a turn.
 * A server prompt does exactly that, so it reuses the mechanism rather than inventing one.
 *
 * Naming: `/server:prompt`. Tool names have to survive provider constraints, which is why
 * those are `mcp__server__tool`; a slash command only has to be read by a person, and
 * `/github:review` is a name you can type.
 *
 * Pure. `connection.ts` fetches, `App.tsx` renders and runs.
 */

/** One declared argument of a prompt. */
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPrompt {
  server: string;
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}

/** Longest prompt description we carry into the command list. */
export const MAX_PROMPT_DESCRIPTION = 256;

/** Does this server say it has prompts at all? */
export function hasPrompts(capabilities: Record<string, unknown>): boolean {
  return Boolean(capabilities?.prompts);
}

/** The slash command for a prompt. */
export function promptCommand(prompt: McpPrompt): string {
  return `/${prompt.server}:${prompt.name}`;
}

/** Split `/server:name` back into its parts, or null if it is not one. */
export function parsePromptCommand(command: string): { server: string; name: string } | null {
  const m = /^\/([^\s:]+):([^\s:]+)$/.exec(command.trim());
  return m ? { server: m[1]!, name: m[2]! } : null;
}

function text(value: unknown, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Parse a `prompts/list` payload, dropping what cannot be used (pure). */
export function parsePromptList(server: string, result: unknown): McpPrompt[] {
  const raw = (result as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(raw)) return [];
  const out: McpPrompt[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const p = item as { name?: unknown; description?: unknown; arguments?: unknown } | null;
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    // A name with a space or a colon could not be typed as a command, and a colon would
    // make `parsePromptCommand` split in the wrong place.
    if (!name || seen.has(name) || /[\s:/]/.test(name)) continue;
    seen.add(name);
    const args = Array.isArray(p?.arguments) ? p.arguments : [];
    out.push({
      server,
      name,
      description: text(p?.description, MAX_PROMPT_DESCRIPTION),
      arguments: args
        .map((a) => {
          const arg = a as { name?: unknown; description?: unknown; required?: unknown } | null;
          const argName = typeof arg?.name === "string" ? arg.name.trim() : "";
          return argName ? { name: argName, description: text(arg?.description, 160), required: arg?.required === true } : null;
        })
        .filter((a): a is McpPromptArgument => a !== null),
    });
  }
  return [...out].sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
}

/** The usage line shown when a prompt is invoked without the arguments it needs. */
export function promptUsage(prompt: McpPrompt): string {
  const args = prompt.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  const detail = prompt.arguments.filter((a) => a.description).map((a) => `  ${a.name} — ${a.description}`);
  return [`Usage: ${promptCommand(prompt)}${args ? ` ${args}` : ""}`, ...detail].join("\n");
}

/**
 * Map positional command arguments onto a prompt's declared ones (pure).
 *
 * Positional, because a slash command is typed by a person in a hurry and
 * `key=value key=value` is not that. The LAST declared argument soaks up whatever is
 * left over, so `/github:review 123 be harsh about tests` puts the whole trailing phrase
 * in one argument instead of silently dropping everything after the first space — which
 * is the failure a naive split produces and nobody notices.
 */
export function mapPromptArguments(prompt: McpPrompt, tokens: readonly string[]): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const declared = prompt.arguments;
  for (let i = 0; i < declared.length; i++) {
    const arg = declared[i]!;
    const isLast = i === declared.length - 1;
    const value = isLast ? tokens.slice(i).join(" ") : (tokens[i] ?? "");
    if (value) values[arg.name] = value;
  }
  const missing = declared.filter((a) => a.required && !values[a.name]).map((a) => a.name);
  return { values, missing };
}

/**
 * Flatten a `prompts/get` result into the text of one user turn (pure).
 *
 * A prompt may come back as several messages with roles. Our transcript takes a plain
 * user message, and inventing assistant turns the model never produced would be putting
 * words in its mouth — so a multi-message prompt is rendered as a labelled transcript
 * inside one message. Single-message prompts, which is nearly all of them, come through
 * as their own text with no decoration at all.
 */
export function renderPromptMessages(result: unknown): string {
  const raw = (result as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) return "";
  const parts: { role: string; text: string }[] = [];
  for (const item of raw) {
    const m = item as { role?: unknown; content?: unknown } | null;
    const role = typeof m?.role === "string" ? m.role : "user";
    const content = m?.content;
    let body = "";
    if (typeof content === "string") body = content;
    else if (Array.isArray(content)) {
      body = content.map((c) => (typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "")).filter(Boolean).join("\n");
    } else if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
      body = (content as { text: string }).text;
    }
    if (body.trim()) parts.push({ role, text: body });
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!.text;
  return parts.map((p) => `[${p.role}]\n${p.text}`).join("\n\n");
}
