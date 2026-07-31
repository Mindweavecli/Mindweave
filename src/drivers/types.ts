/**
 * types.ts — the shared driver contract.
 *
 * Everything in this file is provider-neutral. The core engine speaks only these
 * shapes, so it never learns which model is running; a driver translates them into
 * one provider's wire format and back.
 *
 * This is the only module a driver may import from outside its own folder. Keeping
 * the surface small is what makes drivers swappable: add a provider by writing a
 * renderer for these types, not by touching the agent loop.
 */
import type { ToolSchema } from "../tools/types.js";

// ── Conversation shapes ───────────────────────────────────────────────────────

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
 * A message in the conversation. Assistant messages may carry `tool_calls`; a
 * `tool` message carries one tool's result with the matching `tool_call_id`.
 * Keeping this exact shape is what lets the next request stay well-formed.
 *
 * This is OpenAI-shaped because that is what the transcript is stored as. A driver
 * for a provider with a different shape (Anthropic's content blocks, say) converts
 * on the way out and back on the way in — the stored transcript never changes.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/**
 * Why the model stopped talking. Providers spell these differently; a driver maps
 * its own vocabulary onto this small set.
 *
 *   - `end`        — finished normally, or handed back tool calls to run.
 *   - `truncated`  — hit the output ceiling mid-answer. The reply is INCOMPLETE.
 *   - `refused`    — the provider's safety layer declined. There is no answer.
 *   - `overflow`   — the conversation no longer fits the context window.
 *   - `overloaded` — the provider's infrastructure cut the request off before it
 *                    finished (not a token limit, not a refusal). Worth a plain
 *                    retry later, the reply is INCOMPLETE the same as `truncated`.
 *
 * `truncated` is the one that matters most: without it a cut-off reply looks
 * exactly like a finished one, and the loop carries on with half an answer.
 */
export type StopReason = "end" | "truncated" | "refused" | "overflow" | "overloaded";

/** What one model turn produced: free text and/or a set of tool calls. */
export interface Turn {
  content: string;
  toolCalls: ToolCall[];
  /** Why generation stopped. Absent means the driver didn't report one; treat
   *  that as `end`, which is what every provider means by saying nothing. */
  stop?: StopReason;
}

/**
 * A provider-agnostic request. This split is what makes prompt caching work on
 * EVERY model: `system` + `messages` are a STABLE, cacheable prefix — identical
 * across the steps of a task and across turns, because messages are append-only —
 * while `context` is volatile per-turn content (a ranked code map, the todo list)
 * rendered at the TAIL so it never invalidates the cached prefix. `tools` is also
 * stable and part of the prefix.
 *
 * Each driver consumes this same shape and applies caching its own way:
 *   - OpenAI-compatible providers: automatic prefix caching — it just needs the
 *     prefix kept byte-stable, which this shape guarantees.
 *   - Anthropic: explicit `cache_control` breakpoints at the prefix boundary
 *     (after tools, system, and the last stable message).
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

// ── Usage and streaming ───────────────────────────────────────────────────────

/** Token accounting for a turn, when the provider reports it (streaming only).
 *  `promptTokens` splits into cache hit + miss; the split is what lets us show a
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
 *   - `reasoning` — a chunk of the model's thinking.
 *   - `text`      — a chunk of the visible answer.
 *   - `tool_start`— the model has begun a tool call (name known; args still coming).
 *   - `tool_args` — a fragment of that call's JSON arguments.
 * The terminal `Turn` (with assembled content + tool calls + usage) is the driver
 * call's return value, not an event — so the engine builds the transcript from the
 * same well-formed shape as the non-streaming path.
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

/** Per-call knobs. The model/reasoning selection lives on the ModelRequest;
 *  this is just the cancel signal (Esc to interrupt). */
export interface TurnOptions {
  signal?: AbortSignal;
}

/** Streaming knobs: the turn options plus a sink for the live events. */
export interface StreamOptions extends TurnOptions {
  /** Called for every delta as it arrives. The UI renders from these. */
  onEvent?: (event: StreamEvent) => void;
}

// ── Model selection ───────────────────────────────────────────────────────────

/** A model id, as the provider names it (e.g. `deepseek-v4-flash`). Drivers own
 *  their own id space; core only stores and forwards the string. */
export type ModelId = string;

/**
 * How much reasoning budget to spend when thinking is on. This is the union of
 * every provider's ladder, not one provider's: a driver offers only the rungs its
 * models actually accept, and `normalize` clamps anything else down to a rung it
 * does serve. DeepSeek exposes two of these, Anthropic all five.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Which model answers and how hard it thinks. Persisted per project. */
export interface ModelConfig {
  model: ModelId;
  thinking: boolean;
  /** Only meaningful when `thinking` is true. */
  effort: Effort;
}

/** One entry in the `/model` picker. */
export interface ModelChoice {
  id: ModelId;
  label: string;
  description: string;
}

/** One entry in the `/think` picker, for a given model. */
export interface ThinkLevel {
  label: string;
  description: string;
  thinking: boolean;
  effort: Effort;
}

/** USD per 1,000,000 tokens, split by how each token was billed. */
export interface ModelPrice {
  /** Input tokens served from the prompt cache (cheap — this is why re-send is OK). */
  cacheHit: number;
  /** Fresh input tokens (the real cost of new context). */
  cacheMiss: number;
  /** Generated tokens. */
  output: number;
}

// ── The contract ──────────────────────────────────────────────────────────────

/**
 * A provider's CHEAP metadata: what it offers and what those offerings cost.
 *
 * Manifests are always loaded, for every installed provider, because the pickers
 * and the cost/compaction math need them before anyone has chosen a model. So a
 * manifest must be plain data and pure functions — no SDK imports, no network, no
 * side effects at module load. Anything heavier belongs in the `Driver` below,
 * which is only loaded once its provider is actually selected.
 */
export interface DriverManifest {
  /** Stable identifier, e.g. "deepseek". Used to route and to name the folder. */
  id: string;

  /** Human-readable provider name, e.g. "DeepSeek". Shown during key setup. */
  label: string;

  /** The environment variable holding this provider's API key, e.g.
   *  `DEEPSEEK_API_KEY`. Setup asks for the key belonging to the model the user
   *  is about to run, so this has to be metadata rather than a hard-coded name. */
  apiKeyEnv: string;

  /** Where a user gets a key, shown on the setup screen. */
  keysUrl: string;

  /** The models this provider offers, in `/model` order. The first is its default. */
  models: ModelChoice[];

  /** The reasoning levels `/think` offers for one of this provider's models. */
  thinkLevels(model: ModelId): ThinkLevel[];

  /** Cache-aware price for a model. */
  price(model: ModelId): ModelPrice;

  /**
   * The model's USABLE context window — the span where retrieval and attention
   * stay reliable, which is often well below the advertised storage maximum.
   * Compaction thresholds are derived from this.
   */
  contextWindow(model: ModelId): number;

  /**
   * Coerce a stored/unknown model id into one this provider actually serves, and
   * keep the reasoning intent valid for it (a level the target model lacks is
   * clamped down, an illegal combination is corrected). Called when loading a
   * saved config and when switching models.
   */
  normalize(config: ModelConfig): ModelConfig;
}

/**
 * Everything the core needs to actually TALK to one model family.
 *
 * A driver owns: the HTTP call, the request/streaming format, where prompt-cache
 * breakpoints go, and any model-specific parsing fixes. It extends its manifest so
 * the engine holds one object.
 *
 * Core owns (never a driver): the agent loop, the tools and their safety gates,
 * WHAT the system prompt says, memory, and compaction. A driver controls format,
 * not craft — it must never add "how to code" instructions for a model. The system
 * prompt is byte-identical whichever provider is running; only the envelope differs.
 */
export interface Driver extends DriverManifest {
  /** Ask the model for one turn. */
  toolTurn(request: ModelRequest, options?: TurnOptions): Promise<Turn>;

  /** Ask the model for one turn, streaming deltas to `options.onEvent`. */
  streamTurn(request: ModelRequest, options?: StreamOptions): Promise<StreamResult>;

  /**
   * Optional: clean provider quirks out of streamed text before it is displayed.
   * `toolTurn`/`streamTurn` already return clean content, but the live UI renders
   * raw `text` deltas as they arrive, so a provider that leaks markup into the
   * text channel repairs it here. Defaults to identity when a driver omits it.
   */
  sanitizeText?(raw: string): string;
}
