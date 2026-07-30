/**
 * types.ts — the transcript model.
 *
 * The conversation is a list of `Entry`. This is a discriminated union on
 * `role`, which is the whole point: the compaction transforms and the wire
 * conversion below switch on `role` exhaustively, so the compiler — not a
 * runtime check — guarantees we never build an impossible message (an assistant
 * tool-call with no calls, a tool result with no id). The fragile invariants
 * that a loosely-typed (e.g. Python) implementation can only *hope* hold —
 * "a tool result must follow the assistant tool-call that spawned it" — become
 * things the types make hard to get wrong.
 *
 * The transcript never contains the system message: that's regenerated each turn
 * (it carries the live shell label and project memory), so storing it would just
 * pin a stale copy. Everything here is plain JSON — the same data that will cross
 * the wire when the engine later moves to a server.
 */
import type { ToolContext } from "../tools/types.js";

/** One tool call the assistant made, stored so the turn can be replayed. */
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as the model emitted it
}

/**
 * One message in the conversation.
 *  - `user`      — something the person said.
 *  - `assistant` — Mindweave's reply; may carry tool calls it wants run.
 *  - `tool`      — one tool's result, tied to the call by `toolCallId`. The model
 *                  only ever sees `content`; `summary`/`detail`/`isError` are the
 *                  display fields captured at run time so a resumed session can
 *                  replay the exact same rows (the ● Tool + ⎿ result/diff) instead
 *                  of dropping all tool activity. They ride along in the JSONL for
 *                  free (JSON.stringify) and are ignored when building the wire
 *                  request (only `content` is sent).
 *  - `summary`   — a compaction summary that replaced older turns; sent to the
 *                  model as a user message (see toChatMessages in the engine).
 */
export type Entry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRecord[] }
  | { role: "tool"; toolCallId: string; content: string; summary?: string; detail?: string; isError?: boolean }
  | { role: "summary"; content: string };

/** Lightweight session descriptor for the resume picker (no transcript body). */
export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  firstPrompt: string;
  lastPrompt: string;
  entryCount: number;
  /** Extra roots added via `/include` (absolute paths, excluding the primary cwd).
   *  Restored on resume so a multi-root workspace survives across sessions. */
  extraRoots?: string[];
}

/**
 * A live session: the conversation plus the working state it needs. One of these
 * exists for the whole chat (the CLI owns it). `cwd` is the project root the
 * session is filed under (fixed); the live working directory lives on
 * `toolContext.cwd` and may move as `run_command` does `cd`.
 */
export interface Session {
  id: string;
  cwd: string;
  createdAt: number;
  transcript: Entry[];
  toolContext: ToolContext;
  /** Contents of the project's MINDWEAVE.md, injected into the system prompt. "" if none. */
  projectMemory: string;
  /**
   * The cross-session memory directory for this project (where MEMORY.md and the
   * topic files live) and the loaded MEMORY.md index. The index is injected into
   * the system prompt each turn; the directory path is given to the model so it
   * can read/grep individual topic files on demand. `memoryIndex` is "" when no
   * memory has been saved yet.
   */
  memoryDir: string;
  memoryIndex: string;
  /**
   * The project orientation snapshot (environment + git + signals + tree),
   * rendered for the system prompt. Captured once at session start — a snapshot
   * in time, like the rest of the startup context. "" if nothing useful.
   */
  projectContext: string;
  /**
   * The per-project governor: standing rules, the skill catalog, and the
   * forbidden deny-list. Loaded once at session start from this project's state
   * dir. Rules + skill catalog are rendered into the system prompt; the forbidden
   * config also rides on `toolContext` for mechanical enforcement.
   */
  governance: import("../governor/types.js").Governance;
  /**
   * Which model answers and how hard it thinks (`/model` + `/think`). Loaded from
   * the project's saved choice at session start (sticky per project); the engine
   * passes it to the provider on every turn. Mutated in place when the user picks.
   */
  modelConfig: import("../dynamo/model.js").ModelConfig;
  /**
   * True when the previous turn finished a task (a todo list completed). The next turn
   * uses it to decide whether a NEW request is a task boundary — at which point the
   * finished task's detail is swept so a weaker model can't drift back to it. Transient
   * session state; rides on the session, not persisted meaningfully.
   */
  taskJustCompleted?: boolean;
  /**
   * Consecutive autocompact failures this session — the circuit-breaker that stops
   * retrying a doomed summarization every turn. Reset to 0 on a clean compaction.
   */
  compactFailures?: number;
  /**
   * The maintained "state of this session" notes (session memory) — a structured,
   * continuously-refreshed document injected into every turn so the model keeps a crisp
   * picture across compaction. Lives outside the transcript (compaction never touches
   * it). "" / undefined until the first update. Persisted as a sidecar notes file.
   */
  sessionMemory?: string;
  /** Transcript token count at the last session-memory update (the refresh watermark). */
  sessionMemoryTokens?: number;
  /** Whether session memory has been initialized (past the warm-up bar) yet. */
  sessionMemoryInit?: boolean;
}
