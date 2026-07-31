/**
 * inlineTools.ts — recover tool calls DeepSeek leaks into the TEXT stream.
 *
 * DeepSeek V4 sometimes emits a tool call as plain content using its internal
 * "DSML" markup instead of the structured `tool_calls` field, e.g.
 *
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="todo_write">
 *   <｜｜DSML｜｜parameter name="todos" string="false">[ … ]</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke>
 *   </｜｜DSML｜｜tool_calls>
 *
 * Left alone that does two bad things: the raw markup shows up in the reply, and
 * the call never runs (it was never a real `tool_calls` entry). This module parses
 * those blocks back into real tool calls AND strips them from the visible text. The
 * regexes match on the ASCII keywords (DSML / tool_calls / invoke / parameter) and
 * absorb the surrounding delimiter characters, so they're robust to the exact
 * special glyphs DeepSeek uses.
 *
 * This is a model-specific parsing fix, which is why it lives inside the driver
 * rather than in core.
 */
import type { ToolCall } from "../types.js";

const BLOCK_RE = /<[^<>]*DSML[^<>]*tool_calls\s*>[\s\S]*?<\/[^<>]*DSML[^<>]*tool_calls\s*>/g;
const INVOKE_RE = /<[^<>]*DSML[^<>]*invoke[^<>]*name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*DSML[^<>]*invoke[^<>]*>/g;
const PARAM_RE = /<[^<>]*DSML[^<>]*parameter[^<>]*name="([^"]+)"([^<>]*)>([\s\S]*?)<\/[^<>]*DSML[^<>]*parameter[^<>]*>/g;

export interface ParsedInline {
  /** The content with every leaked tool-call block removed. */
  cleaned: string;
  /** Tool calls recovered from those blocks (empty when there were none). */
  toolCalls: ToolCall[];
}

/** True if the text contains a leaked DSML tool-call block (cheap pre-check). */
export function hasInlineToolCalls(content: string): boolean {
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(content);
}

/** Strip leaked tool-call markup from text for DISPLAY (no parsing). */
export function stripInlineToolCalls(content: string): string {
  return content.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Parse leaked tool-call blocks into real tool calls and return the cleaned text. */
export function parseInlineToolCalls(content: string): ParsedInline {
  const toolCalls: ToolCall[] = [];
  let n = 0;
  for (const block of content.match(BLOCK_RE) ?? []) {
    INVOKE_RE.lastIndex = 0;
    let inv: RegExpExecArray | null;
    while ((inv = INVOKE_RE.exec(block)) !== null) {
      const name = inv[1]!;
      const args: Record<string, unknown> = {};
      PARAM_RE.lastIndex = 0;
      let p: RegExpExecArray | null;
      while ((p = PARAM_RE.exec(inv[2]!)) !== null) {
        const key = p[1]!;
        const attrs = p[2] ?? "";
        const raw = p[3]!.trim();
        // The convention DeepSeek follows: a parameter is a string unless it's
        // flagged `string="false"`, in which case its value is JSON.
        args[key] = /string="false"/i.test(attrs) ? tryJson(raw) : raw;
      }
      toolCalls.push({ id: `inline_${Date.now()}_${n++}`, name, arguments: JSON.stringify(args) });
    }
  }
  return { cleaned: stripInlineToolCalls(content), toolCalls };
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not valid JSON → keep the literal text
  }
}
