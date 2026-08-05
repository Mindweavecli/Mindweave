/**
 * manifest.ts — what Anthropic offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code (and the SDK) live in `client.ts`, which
 * only loads once a Claude model is actually selected.
 *
 * v1 ships the two models on Anthropic's current request surface: `claude-opus-5`
 * (most capable) and `claude-sonnet-5` (the default here — near-Opus quality on
 * coding and agentic work at a lower rate). Both take adaptive thinking plus an
 * `effort` level, and both reject the older `budget_tokens` and sampling
 * parameters. Haiku 4.5 is deliberately NOT offered yet: it predates that surface
 * and would need a second, legacy request path (fixed thinking budgets, no
 * effort), which is complexity this driver doesn't need to carry to be useful.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const OPUS = "claude-opus-5";
export const SONNET = "claude-sonnet-5";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = SONNET;

/** The models offered by `/model`. First entry is this provider's default. */
export const MODELS: ModelChoice[] = [
  { id: SONNET, label: "Claude Sonnet 5", description: "fast, strong at code — the default" },
  { id: OPUS, label: "Claude Opus 5", description: "most capable, for the hardest work" },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * Anthropic separates "does it think" from "how hard": thinking is adaptive (the
 * model decides depth per request) and `effort` sets the overall budget. Both
 * models take the same rungs, so one table serves them.
 *
 * Standard deliberately pairs no-thinking with `high` rather than a lower rung:
 * on Opus 5 thinking may only be turned off at effort `high` or below, so this is
 * the setting that keeps a no-thinking request legal on both models.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

/**
 * List prices (USD / 1M tokens). Cache reads are ~1/10 of fresh input, which is
 * what keeps a re-sent conversation cheap. Sonnet is running an introductory rate
 * below this through 2026-08-31; the durable list price is used here so the
 * estimate doesn't start under-reporting the moment that ends.
 */
const PRICES: Record<string, ModelPrice> = {
  [SONNET]: { cacheHit: 0.3, cacheMiss: 3, output: 15 },
  [OPUS]: { cacheHit: 0.5, cacheMiss: 5, output: 25 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Both models STORE 1M tokens, but this is
 * deliberately the sharp window rather than the storage cap: on BYOK every token
 * in the window is the user's money on every turn, so anchoring compaction at 1M
 * would mean carrying an enormous prompt long after it stopped earning its cost.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single buffered (non-streaming) call.
 *
 * Both models accept 128K output, but a non-streaming request that runs that long
 * risks an HTTP timeout, so the buffered path — core's small internal calls, like
 * a compaction summary — is deliberately capped far lower. `client.ts` sends this
 * value and `dynamo/contextWindow.ts` reserves it; keeping one exported constant
 * means the request and the reservation cannot drift apart.
 *
 * The streaming ceiling is a separate, much larger number and lives in `client.ts`,
 * because nothing in core needs to reserve room for it.
 */
export const BUFFERED_OUTPUT_TOKENS = 16_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** Effort rungs both models accept, in order. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * The one hard rule to enforce: on Opus 5, thinking may only be DISABLED at
 * effort `high` or below — pairing no-thinking with `xhigh` or `max` is rejected
 * by the API. Rather than let that reach the wire, a no-thinking config steps its
 * effort down to `high` here.
 */
/**
 * Both models offered here read images. Anthropic accepts JPEG, PNG, GIF and WebP,
 * and downscales anything oversized itself, so this driver takes what core sends and
 * adds no resizing of its own.
 */
export function acceptsImages(_model: ModelId): boolean {
  return true;
}

export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = config.model === OPUS ? OPUS : SONNET;
  const thinking = config.thinking === true;
  let effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
  if (!thinking && (effort === "xhigh" || effort === "max")) effort = "high";
  return { model, thinking, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const anthropicManifest: DriverManifest = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  keysUrl: "https://console.anthropic.com/settings/keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  normalize,
};
