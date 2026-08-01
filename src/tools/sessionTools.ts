/**
 * sessionTools.ts — the model's handle on its OWN past work in this project.
 *
 * Every session is already saved to disk: a transcript, a descriptor, and a running
 * notes file the session maintains as it goes. Nothing could read any of it. Asked
 * "what did we do last session", the agent could only say that some number of
 * sessions existed and tell the user to run a command themselves — which is not an
 * answer, it is a deflection with a citation.
 *
 * Two tools fix that, and the split between them is the whole design:
 *
 *  - `list_sessions` is cheap. Dates, opening prompt, last prompt, size. No
 *    transcript is opened, so the model can always afford to look.
 *  - `read_session` defaults to the NOTES, not the transcript. The notes are the
 *    session's own maintained summary of what it did and where it got to — already
 *    written, already compact, already the thing a human means by "what did we do".
 *    The raw transcript is available but must be asked for, because it is unbounded
 *    and can be enormous.
 *
 * Read-only, and scoped to THIS project's directory: these read the agent's own
 * saved work and nothing else. Another tool's data stays behind the ask-first gate
 * in guard.ts.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { anchorOf } from "./paths.js";
import { listSessions, loadSessionNotes, loadTranscript } from "../memory/store.js";
import type { Entry, SessionMeta } from "../memory/types.js";

/** How many sessions to list at once unless asked for more. */
const DEFAULT_LIMIT = 10;
/** Characters of transcript to return before clipping — a transcript is unbounded. */
const MAX_TRANSCRIPT_CHARS = 20_000;

export const listSessionsTool: Tool = {
  name: "list_sessions",
  readOnly: true,
  description:
    "List your own past sessions in this project, most recent first: when each ran, " +
    "what the user opened with, what they last asked, and how long it went. Use this " +
    "when the user refers to earlier work ('last session', 'what did we do', 'the bug " +
    "we fixed yesterday') — you have this history, so look it up instead of guessing " +
    "or saying you cannot see it. Cheap: no transcripts are opened. Follow up with " +
    "read_session to get what actually happened in one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: `How many to list (default ${DEFAULT_LIMIT}, newest first).`,
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const root = anchorOf(ctx);
    const all = await listSessions(root);
    const past = all.filter((m) => m.id !== ctx.sessionId);
    if (past.length === 0) {
      return { output: "No earlier sessions are saved for this project.", summary: "no past sessions" };
    }
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, 50);
    const shown = past.slice(0, limit);
    const lines = shown.map(describe);
    const more = past.length > shown.length ? `\n\n(${past.length - shown.length} older, raise \`limit\` to see them.)` : "";
    return {
      output:
        `Your past sessions in this project, newest first. Use read_session with an id ` +
        `for what happened in one:\n\n${lines.join("\n\n")}${more}`,
      summary: `${past.length} past session${past.length === 1 ? "" : "s"}`,
    };
  },
};

export const readSessionTool: Tool = {
  name: "read_session",
  readOnly: true,
  description:
    "Read what happened in one of your past sessions. By default returns that " +
    "session's maintained notes — its own running summary of the work and where it " +
    "got to, which is what someone means by 'what did we do'. Pass full:true only if " +
    "the notes are missing or you genuinely need the raw exchange; transcripts are " +
    "large. Get ids from list_sessions, or omit `id` for the most recent session.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "The session id from list_sessions. Omit for the most recent past session.",
      },
      full: {
        type: "boolean",
        description: "Return the raw transcript instead of the notes. Large — only when the notes don't answer it.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const root = anchorOf(ctx);
    const all = await listSessions(root);
    const past = all.filter((m) => m.id !== ctx.sessionId);
    if (past.length === 0) {
      return { output: "No earlier sessions are saved for this project.", summary: "no past sessions" };
    }

    const wanted = typeof args.id === "string" ? args.id.trim() : "";
    const meta = wanted ? past.find((m) => m.id === wanted) : past[0];
    if (!meta) {
      return fail(
        `no saved session with id '${wanted}'. Call list_sessions to see which ids exist.`,
      );
    }

    const header = describe(meta);
    if (args.full === true) {
      const transcript = await loadTranscript(root, meta.id);
      return {
        output: `${header}\n\n${renderTranscript(transcript ?? [])}`,
        summary: `session ${short(meta.id)} (transcript)`,
      };
    }

    const notes = await loadSessionNotes(root, meta.id);
    if (!notes) {
      return {
        output:
          `${header}\n\nThat session kept no notes (it may have been short). Its opening and ` +
          `closing prompts are above; call read_session with full:true for the raw transcript.`,
        summary: `session ${short(meta.id)} (no notes)`,
      };
    }
    return {
      output: `${header}\n\nWhat that session recorded about its own work:\n\n${notes}`,
      summary: `session ${short(meta.id)} (notes)`,
    };
  },
};

/** One session as a compact block: id, when, size, and the prompts that bracket it. */
function describe(meta: SessionMeta): string {
  const parts = [
    `id: ${meta.id}`,
    `when: ${timeAgo(meta.updatedAt)} (${new Date(meta.updatedAt).toISOString().slice(0, 16).replace("T", " ")})`,
    `length: ${meta.entryCount} messages`,
    `opened with: ${clip(meta.firstPrompt)}`,
  ];
  // The last prompt is only worth a line when it differs — a one-exchange session
  // would otherwise print the same text twice.
  if (meta.lastPrompt && meta.lastPrompt.trim() !== meta.firstPrompt.trim()) {
    parts.push(`last asked: ${clip(meta.lastPrompt)}`);
  }
  return parts.join("\n");
}

/** Render a saved transcript readably, clipped — transcripts have no size bound. */
function renderTranscript(entries: Entry[]): string {
  const body = entries
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => `${e.role === "user" ? "User" : "You"}: ${e.content.trim()}`)
    .filter((line) => line.length > 6)
    .join("\n\n");
  if (!body) return "(that session's transcript is empty)";
  return body.length > MAX_TRANSCRIPT_CHARS
    ? body.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n… (transcript clipped)"
    : body;
}

/** "3 days ago" / "2 hours ago" — how a human refers to a past session. */
export function timeAgo(when: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
  ];
  let label = "minute";
  let size = 60;
  for (const [unitSeconds, name] of units) {
    if (seconds >= unitSeconds) {
      size = unitSeconds;
      label = name;
    }
  }
  const n = Math.floor(seconds / size);
  return `${n} ${label}${n === 1 ? "" : "s"} ago`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function clip(text: string, max = 140): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "(nothing recorded)";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
