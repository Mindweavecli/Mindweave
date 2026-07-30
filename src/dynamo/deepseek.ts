/**
 * deepseek.ts — the provider client.
 *
 * The single place that knows how to talk to DeepSeek's HTTP API. The engine
 * does not know about URLs, headers, or keys — it asks for a turn and gets back
 * either text or tool calls. When we add other providers later, each gets its
 * own client file with this same shape, and the engine stays unchanged.
 *
 * DeepSeek's API is OpenAI-compatible, so this is a plain chat/completions call
 * with native function-calling (`tools[]` → `tool_calls`). We use native tool
 * calls — not a homemade text protocol — because the structured form can't be
 * mis-parsed and is markedly more reliable across models.
 */
import type { ToolSchema } from "../tools/types.js";
import type { ModelConfig } from "./model.js";
import { parseInlineToolCalls } from "./inlineTools.js";

// v1 ships two DeepSeek models: `deepseek-v4-flash` (fast, cheap default) and
// `deepseek-v4-pro` (stronger). Both are OpenAI-compatible, 1M context, and
// support Thinking / Non-Thinking modes. The old `deepseek-chat` /
// `deepseek-reasoner` IDs are deprecated and stop working after 2026-07-24.
const BASE_URL = process.env.MINDWEAVE_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.MINDWEAVE_MODEL ?? "deepseek-v4-flash";

/** One tool call the model wants us to run. `arguments` is a raw JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool call echoed back to the provider, in the wire shape it expects. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A message in the conversation, in OpenAI shape. Assistant messages may carry
 * `tool_calls`; a `tool` message carries one tool's result with the matching
 * `tool_call_id`. Keeping this exact shape is what lets the next request stay
 * well-formed.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** What one model turn produced: free text and/or a set of tool calls. */
export interface Turn {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * A provider-agnostic request. This split is what makes prompt caching work on
 * EVERY model: `system` + `messages` are a STABLE, cacheable prefix — identical
 * across the steps of a task and across turns, because messages are append-only —
 * while `context` is volatile per-turn content (a ranked code map, the todo list)
 * rendered at the TAIL so it never invalidates the cached prefix. `tools` is also
 * stable and part of the prefix.
 *
 * Each provider consumes this same shape and applies caching its own way:
 *   - OpenAI-compatible (DeepSeek, GLM, OpenAI, …): automatic prefix caching — it
 *     just needs the prefix kept byte-stable, which this shape guarantees. This is
 *     what `renderMessages` below produces.
 *   - Anthropic: needs explicit `cache_control` breakpoints at the prefix boundary
 *     (after tools, system, and the last stable message); a future anthropic
 *     provider reads this same ModelRequest and inserts them.
 *   - Gemini: explicit cached-content API, same principle.
 * So adding a model is "write a renderer for this request," and the cache-friendly
 * structure is decided once, here, for all of them.
 */
export interface ModelRequest {
  /** Stable, cacheable system instructions. */
  system: string;
  /** The conversation so far — append-only, no system message inside. */
  messages: ChatMessage[];
  /** Volatile per-turn context, rendered at the tail and kept OUT of the cache prefix. */
  context?: string;
  /** Tools the model may call; empty/omitted forces a plain-text answer. */
  tools?: ToolSchema[];
  /** Model + reasoning selection. */
  model?: ModelConfig;
}

/**
 * Render a ModelRequest to OpenAI-shape wire messages: the stable system prompt,
 * the stable conversation, then the volatile context as a trailing block. Keeping
 * `context` strictly last is what preserves the cacheable prefix — DeepSeek (and
 * any OpenAI-compatible provider) caches the longest identical prefix from token 0,
 * so anything volatile must come after everything we want cached.
 */
export function renderMessages(req: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: req.system }, ...req.messages];
  if (req.context && req.context.trim()) {
    // A trailing USER message is the most universally accepted shape across
    // OpenAI-compatible providers (a non-leading system message is not guaranteed
    // to be honored). It's clearly framed as current context, not the human talking.
    messages.push({ role: "user", content: `<current_context>\n${req.context}\n</current_context>` });
  }
  return messages;
}

/** Token accounting for a turn, when the provider reports it (streaming only).
 *  `prompt_tokens` splits into cache hit + miss; the split is what lets us show a
 *  cache-aware cost instead of a misleading raw sum. Providers that don't report
 *  the split leave the two at 0 (the cost summary then treats the prompt as fresh). */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

/**
 * A live event from a streaming turn. The engine forwards these to the UI so the
 * reply paints as it's generated:
 *   - `reasoning` — a chunk of the model's thinking (DeepSeek `reasoning_content`).
 *   - `text`      — a chunk of the visible answer.
 *   - `tool_start`— the model has begun a tool call (name known; args still coming).
 *   - `tool_args` — a fragment of that call's JSON arguments.
 * The terminal `Turn` (with assembled content + tool calls + usage) is the
 * function's return value, not an event — so the engine builds the transcript from
 * the same well-formed shape as the non-streaming path.
 */
export type StreamEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_args"; index: number; delta: string };

/** A completed streaming turn: the assembled reply plus usage when reported. */
export interface StreamResult extends Turn {
  usage?: Usage;
}

/** Per-call knobs. The model/reasoning selection lives on the ModelRequest now;
 *  this is just the cancel signal (Esc to interrupt). */
export interface TurnOptions {
  signal?: AbortSignal;
}

/** Streaming knobs: the turn options plus a sink for the live events. */
export interface StreamOptions extends TurnOptions {
  /** Called for every delta as it arrives. The UI renders from these. */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Ask the model for one turn. Pass the tools it may call; an empty `tools`
 * array forces a tool-less, plain-text answer (used to wrap a run up).
 *
 * Reasoning is a request-body toggle on DeepSeek V4: thinking mode adds
 * `thinking: { type: "enabled" }` plus a `reasoning_effort` budget. Non-thinking
 * omits both. (Thinking mode also returns a separate `reasoning_content`, which we
 * deliberately ignore — only the answer `content` reaches the transcript.)
 */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const cfg = req.model;
  const tools = req.tools ?? [];
  const body: Record<string, unknown> = {
    model: cfg?.model ?? MODEL,
    messages: renderMessages(req),
    stream: false,
  };
  if (cfg?.thinking) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = cfg.effort;
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const data = (await post(body, options.signal)) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: WireToolCall[] };
    }[];
  };

  const message = data.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments || "{}",
  }));

  // Same DSML-leak guard as the streaming path: recover inline tool calls and
  // strip the markup from the content.
  const inline = parseInlineToolCalls(content);
  if (toolCalls.length === 0 && inline.toolCalls.length > 0) toolCalls.push(...inline.toolCalls);

  return { content: inline.cleaned, toolCalls };
}

/**
 * Ask the model for one turn, STREAMING. Identical request to `toolTurn` but with
 * `stream: true`, so the answer (and the model's reasoning, and each tool call's
 * arguments) arrive as Server-Sent Events. Each delta is handed to `onEvent` for
 * the live UI; the assembled turn is the return value, in the exact same shape the
 * engine already records — so the transcript stays well-formed whether we streamed
 * or not.
 *
 * `stream_options.include_usage` asks DeepSeek to append a final chunk carrying the
 * token counts, which we surface for the "elapsed · tokens" footer.
 */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const cfg = req.model;
  const tools = req.tools ?? [];
  const body: Record<string, unknown> = {
    model: cfg?.model ?? MODEL,
    messages: renderMessages(req),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (cfg?.thinking) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = cfg.effort;
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await postStream(body, options.signal);
  return consumeStream(response, options.onEvent);
}

/**
 * Read an SSE response into a finished turn, emitting each delta along the way.
 * OpenAI-shaped streaming: every `data:` line is a chunk whose `choices[0].delta`
 * carries some of `content`, `reasoning_content`, or `tool_calls`. Tool calls are
 * fragmented — the first fragment for an index brings the id + name, later ones
 * append `arguments` text — so we accumulate them by index. A trailing `usage`
 * object (from include_usage) gives the token counts.
 */
export async function consumeStream(
  response: Pick<Response, "body">,
  onEvent?: (event: StreamEvent) => void,
): Promise<StreamResult> {
  let content = "";
  // Tool calls under construction, keyed by their streaming index. `started`
  // guards the one-time tool_start emit (fired when the name first appears).
  const tools = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  let usage: Usage | undefined;

  for await (const data of sseLines(response)) {
    if (data === "[DONE]") break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue; // ignore keep-alive comments / malformed lines
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        cacheHitTokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
        cacheMissTokens: chunk.usage.prompt_cache_miss_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      onEvent?.({ type: "reasoning", delta: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onEvent?.({ type: "text", delta: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      let acc = tools.get(index);
      if (!acc) {
        acc = { id: "", name: "", args: "", started: false };
        tools.set(index, acc);
      }
      if (tc.id) acc.id = tc.id;
      // Name usually arrives whole in the first fragment, but append defensively
      // in case a provider splits it — the accumulator stays correct either way.
      if (tc.function?.name) acc.name += tc.function.name;
      // Emit tool_start once we know the name (id may still be filling in).
      if (!acc.started && acc.name) {
        acc.started = true;
        onEvent?.({ type: "tool_start", index, id: acc.id, name: acc.name });
      }
      const argFragment = tc.function?.arguments;
      if (argFragment) {
        acc.args += argFragment;
        onEvent?.({ type: "tool_args", index, delta: argFragment });
      }
    }
  }

  const toolCalls: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));

  // Recover any tool calls DeepSeek leaked into the text stream as DSML markup
  // (so they actually run), and strip that markup from the content either way.
  const inline = parseInlineToolCalls(content);
  if (toolCalls.length === 0 && inline.toolCalls.length > 0) toolCalls.push(...inline.toolCalls);

  return { content: inline.cleaned, toolCalls, usage };
}

/** The slice of a streaming chunk we read (OpenAI-compatible SSE shape). */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * Yield each SSE `data:` payload from a streamed response body. SSE frames are
 * separated by a blank line; a frame may carry one or more `data:` lines. We
 * decode incrementally and only emit once a full frame has arrived, so a payload
 * split across network packets is never parsed half-formed.
 */
async function* sseLines(response: Pick<Response, "body">): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  // `response.body` is a web ReadableStream; Node exposes it as async-iterable.
  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let sep: number;
    // Frames end at a blank line (\n\n); tolerate \r\n hosts too.
    while ((sep = firstFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
      const payload = frameData(frame);
      if (payload !== null) yield payload;
    }
  }
}

/** Index just past the first frame separator (blank line) in `buf`, or -1. */
function firstFrameEnd(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}

/** Join the `data:` lines of one SSE frame into its payload, or null if none. */
function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** POST a streaming request, returning the raw response for SSE reading. Shares the
 *  key/error handling with `post` but does not buffer or JSON-parse the body. */
async function postStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek API error ${response.status}: ${detail || response.statusText}`);
  }
  return response;
}

/** The DeepSeek API key, or a clear setup error if it isn't configured yet. */
function requireApiKey(): string {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No DEEPSEEK_API_KEY found. Add your key to the global config so Mindweave works " +
        "in every project:\n" +
        "  ~/.mindweave/.env  →  DEEPSEEK_API_KEY=your-key-here\n" +
        "(A per-project .env or an exported shell variable also works.)",
    );
  }
  return apiKey;
}

/** POST to chat/completions with the API key, surfacing errors as thrown text.
 *  An optional AbortSignal lets the caller (Esc to interrupt) cancel the request. */
async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek API error ${response.status}: ${detail || response.statusText}`,
    );
  }

  return response.json();
}
