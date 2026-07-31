/**
 * transcript.ts — the chat transcript as a pure state machine (no React/Ink).
 *
 * A committed/tail drain model, because it fixes the two things that made
 * Mindweave's first streaming cut glitch:
 *
 *  - WHOLE-BLOCK REVEAL, never typewriter. Streamed text tokens accumulate
 *    SILENTLY into `raw`; the assistant block renders nothing until it seals, then
 *    the whole text appears at once. No per-character churn, no half-rendered
 *    markdown.
 *  - A TINY live region. `committed[]` is append-only and feeds Ink's <Static>
 *    (printed once → real terminal scrollback you can scroll). `tail[]` holds only
 *    in-progress blocks. `drain()` moves the finished prefix of the tail into
 *    committed the instant it (and every earlier block) is done — so the
 *    live-rendered region stays a few rows, which is what lets the prompt stay
 *    pinned and the scrollback scroll without jank.
 *
 * App feeds stream events in as Actions and renders `committed` + `tail`. The one
 * invariant: a block only commits once it AND every earlier tail block is done, so
 * a later block can never print before an earlier one.
 */
import { sanitizeStreamText } from "../drivers/registry.js";
import type { ToolKind } from "./toolDisplay.js";

export type ToolStatus = "running" | "ok" | "error";

/** One entry in a discovery group (a read/search/list/map call). */
export interface ToolGroupItem {
  toolId: string;
  name: string;
  arg?: string;
  status: ToolStatus;
  /** Action category, for the dot colour. */
  kind?: ToolKind;
  /** The call's one-line result ("195 lines", "12 files"), shown once it resolves. */
  note?: string;
}

export type Block =
  | { kind: "user"; id: number; done: boolean; text: string }
  | { kind: "assistant"; id: number; done: boolean; text: string }
  | {
      kind: "tool";
      id: number;
      done: boolean;
      toolId: string;
      /** Display name already mapped (e.g. "Update", "Read", "Run"). */
      name: string;
      /** The telling argument (a filename, a search pattern, a command). */
      arg?: string;
      /** Action category, for the row's dot colour. */
      action?: ToolKind;
      status: ToolStatus;
      /** One-line result when there's no rich detail (e.g. "195 lines"). */
      summary?: string;
      /** Rich block under the row — an edit diff, file preview, or output. */
      detail?: string;
    }
  /** A consolidated group of consecutive discovery calls (reads/searches/maps),
   *  shown as one updating row ("Exploring… (9)") then a compact list. */
  | { kind: "tools"; id: number; done: boolean; items: ToolGroupItem[] }
  /** A spawned sub-agent: its own nested block, keyed by `agentId`. Its tool calls
   *  stream live as compact rail items while it works, then it collapses to a
   *  one-line summary. Distinct violet identity — a separate mind, in the transcript. */
  | {
      kind: "subagent";
      id: number;
      done: boolean;
      agentId: string;
      task: string;
      readOnly: boolean;
      status: ToolStatus;
      /** The closing line once done ("3 steps · read-only"), red on failure. */
      summary?: string;
      items: ToolGroupItem[];
    }
  | { kind: "error"; id: number; done: boolean; text: string }
  | { kind: "completion"; id: number; done: boolean; text: string }
  /** A dim meta line (a tool-less activity note or a command header). */
  | { kind: "note"; id: number; done: boolean; text: string }
  /** A set-off, dim context line (compaction / context trimming). */
  | { kind: "context"; id: number; done: boolean; text: string };

export interface TranscriptState {
  /** Finished, append-only → <Static> (terminal scrollback). */
  committed: Block[];
  /** In-progress, re-rendered live. Kept tiny by draining. */
  tail: Block[];
  /** Id of the streaming assistant block, if one is open. */
  openAsstId: number | null;
  /** Raw accumulated text for that block (hidden until it seals). */
  raw: string;
  /** toolId → block id, so a tool_end finds its row. */
  toolMap: Record<string, number>;
  /** Monotonic id source. */
  seq: number;
  /** The turn's final reply text (recorded into history on the engine side). */
  lastReply: string;
}

export type Action =
  | { type: "user"; text: string }
  | { type: "token"; delta: string }
  | { type: "toolStart"; toolId: string; name: string; arg?: string; action?: ToolKind; group?: boolean }
  | { type: "toolEnd"; toolId: string; ok: boolean; summary?: string; detail?: string }
  // A sub-agent's nested lifecycle: a start opens its rail block, its tool calls fold
  // in as rail items (subTool*), and end collapses it to a summary. Keyed by agentId.
  | { type: "subagentStart"; agentId: string; task: string; readOnly: boolean }
  | { type: "subToolStart"; agentId: string; toolId: string; name: string; arg?: string; action?: ToolKind }
  | { type: "subToolEnd"; agentId: string; toolId: string; ok: boolean; summary?: string }
  | { type: "subagentEnd"; agentId: string; ok: boolean; summary?: string }
  | { type: "sealNarration" } // reveal the open narration block (NOT the reply)
  | { type: "finishReply" } // seal the open assistant block AS the turn's reply
  | { type: "error"; text: string }
  | { type: "completion"; text: string }
  | { type: "note"; text: string } // dim meta line (committed directly)
  | { type: "context"; text: string } // a set-off context/compaction line
  | { type: "say"; text: string }; // an assistant markdown block, NOT recorded as the reply

export function initialState(): TranscriptState {
  return { committed: [], tail: [], openAsstId: null, raw: "", toolMap: {}, seq: 0, lastReply: "" };
}

/** Move the contiguous finished prefix of the tail into committed[]. */
function drain(s: TranscriptState): TranscriptState {
  let i = 0;
  while (i < s.tail.length && s.tail[i]!.done) i++;
  if (i === 0) return s;
  return { ...s, committed: s.committed.concat(s.tail.slice(0, i)), tail: s.tail.slice(i) };
}

function patchTail(s: TranscriptState, id: number, fields: Partial<Block>): TranscriptState {
  return { ...s, tail: s.tail.map((b) => (b.id === id ? ({ ...b, ...fields } as Block) : b)) };
}

/** Close an open discovery group so it can commit, before any non-grouped event. */
function closeToolGroup(s: TranscriptState): TranscriptState {
  const open = s.tail.find((b) => b.kind === "tools" && !b.done);
  return open ? drain(patchTail(s, open.id, { done: true } as Partial<Block>)) : s;
}

/**
 * Seal the streaming assistant block: finalize its text and commit it, or drop it
 * if it never produced visible prose. `asReply` records the text as the turn's
 * reply (for history); narration sealed by a following tool is not the reply.
 */
function sealAssistant(s: TranscriptState, asReply: boolean): TranscriptState {
  const id = s.openAsstId;
  if (id == null) return asReply ? { ...s, lastReply: "" } : s;
  // Let the active driver repair anything its provider leaked into the text
  // stream (the assembled turn is already clean; live deltas are not).
  const text = sanitizeStreamText(s.raw);
  let next: TranscriptState = { ...s, openAsstId: null, raw: "" };
  if (text) next = patchTail(next, id, { text, done: true });
  else next = { ...next, tail: next.tail.filter((b) => b.id !== id) };
  if (asReply) next = { ...next, lastReply: text };
  return drain(next);
}

export function reduce(s: TranscriptState, a: Action): TranscriptState {
  switch (a.type) {
    case "user": {
      const id = s.seq + 1;
      return drain({ ...s, seq: id, tail: s.tail.concat({ kind: "user", id, done: true, text: a.text }) });
    }
    case "token": {
      // Accumulate SILENTLY — the assistant block renders nothing until it seals,
      // then the whole text appears at once. We still open the block so a later
      // seal can find it. Narration after a discovery burst closes the group.
      let next = closeToolGroup(s);
      let openId = next.openAsstId;
      if (openId == null) {
        openId = next.seq + 1;
        next = {
          ...next,
          seq: openId,
          openAsstId: openId,
          raw: "",
          tail: next.tail.concat({ kind: "assistant", id: openId, done: false, text: "" }),
        };
      }
      return { ...next, raw: next.raw + a.delta };
    }
    case "toolStart": {
      // Seal any narration before the tool (commit it) first.
      const sealed = sealAssistant(s, false);

      if (a.group) {
        // A discovery call: fold it into the open group, or open a new one. The
        // group is NOT drained — it stays live so more calls can join it.
        const open = sealed.tail.find((b) => b.kind === "tools" && !b.done);
        if (open && open.kind === "tools") {
          const item: ToolGroupItem = { toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running" };
          return {
            ...sealed,
            toolMap: { ...sealed.toolMap, [a.toolId]: open.id },
            tail: sealed.tail.map((b) =>
              b.id === open.id && b.kind === "tools" ? { ...b, items: [...b.items, item] } : b,
            ),
          };
        }
        const gid = sealed.seq + 1;
        return {
          ...sealed,
          seq: gid,
          toolMap: { ...sealed.toolMap, [a.toolId]: gid },
          tail: sealed.tail.concat({
            kind: "tools",
            id: gid,
            done: false,
            items: [{ toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running" }],
          }),
        };
      }

      // A mutating/standalone tool: close any open group, then show it on its own row.
      const closed = closeToolGroup(sealed);
      const id = closed.seq + 1;
      return drain({
        ...closed,
        seq: id,
        toolMap: { ...closed.toolMap, [a.toolId]: id },
        tail: closed.tail.concat({
          kind: "tool",
          id,
          done: false,
          toolId: a.toolId,
          name: a.name,
          arg: a.arg,
          action: a.action,
          status: "running",
        }),
      });
    }
    case "toolEnd": {
      const blockId = s.toolMap[a.toolId];
      if (blockId == null) return s;
      const block = s.tail.find((b) => b.id === blockId);
      if (block && block.kind === "tools") {
        // Resolve this item's status in place AND capture its one-line result, so the
        // group list shows what each call found (195 lines / 12 files), not just a name.
        return patchTail(s, blockId, {
          items: block.items.map((it) =>
            it.toolId === a.toolId ? { ...it, status: a.ok ? "ok" : "error", note: a.summary } : it,
          ),
        } as Partial<Block>);
      }
      return drain(
        patchTail(s, blockId, {
          status: a.ok ? "ok" : "error",
          summary: a.summary,
          detail: a.detail,
          done: true,
        }),
      );
    }
    case "error": {
      const sealed = sealAssistant(closeToolGroup(s), false);
      const id = sealed.seq + 1;
      return drain({ ...sealed, seq: id, tail: sealed.tail.concat({ kind: "error", id, done: true, text: a.text }) });
    }
    case "sealNarration":
      return sealAssistant(closeToolGroup(s), false);
    case "finishReply":
      return sealAssistant(closeToolGroup(s), true);
    case "completion": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "completion", id, done: true, text: a.text }) });
    }
    case "note": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "note", id, done: true, text: a.text }) });
    }
    case "context": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "context", id, done: true, text: a.text }) });
    }
    case "say": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "assistant", id, done: true, text: a.text }) });
    }
    case "subagentStart": {
      // A new nested block: seal any narration, close any open discovery group, then
      // open the worker's rail. Left LIVE (done:false) so its tool calls can join it.
      const sealed = closeToolGroup(sealAssistant(s, false));
      const id = sealed.seq + 1;
      return drain({
        ...sealed,
        seq: id,
        tail: sealed.tail.concat({
          kind: "subagent",
          id,
          done: false,
          agentId: a.agentId,
          task: a.task,
          readOnly: a.readOnly,
          status: "running",
          items: [],
        }),
      });
    }
    case "subToolStart": {
      const blk = openSubagent(s, a.agentId);
      if (!blk) return s;
      const item: ToolGroupItem = { toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running" };
      return patchTail(s, blk.id, { items: [...blk.items, item] } as Partial<Block>);
    }
    case "subToolEnd": {
      const blk = openSubagent(s, a.agentId);
      if (!blk) return s;
      return patchTail(s, blk.id, {
        items: blk.items.map((it) =>
          it.toolId === a.toolId ? { ...it, status: a.ok ? "ok" : "error", note: a.summary } : it,
        ),
      } as Partial<Block>);
    }
    case "subagentEnd": {
      const blk = openSubagent(s, a.agentId);
      if (!blk) return s;
      return drain(
        patchTail(s, blk.id, { status: a.ok ? "ok" : "error", summary: a.summary, done: true } as Partial<Block>),
      );
    }
  }
}

/** The open (still-running) sub-agent block for an agentId, if one is in the tail. */
function openSubagent(s: TranscriptState, agentId: string): (Block & { kind: "subagent" }) | undefined {
  const blk = s.tail.find((b) => b.kind === "subagent" && b.agentId === agentId && !b.done);
  return blk && blk.kind === "subagent" ? blk : undefined;
}
