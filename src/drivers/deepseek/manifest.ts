/**
 * manifest.ts — what DeepSeek offers, and the numbers that describe it.
 *
 * Everything here is DeepSeek-specific by design: the model list `/model` shows,
 * the reasoning levels `/think` shows, list prices, and the usable context window.
 * A new provider supplies its own version of this file and nothing in core changes.
 *
 * This file is loaded even when the user is running a different provider, so it
 * stays plain data and pure functions. The wire code lives in `client.ts`, which
 * only loads once DeepSeek is actually selected.
 *
 * v1 ships two models: `deepseek-v4-flash` (fast, cheap default) and
 * `deepseek-v4-pro` (stronger). Both are OpenAI-compatible, store 1M tokens, and
 * support Thinking / Non-Thinking modes. The older `deepseek-chat` /
 * `deepseek-reasoner` ids are deprecated and stop working after 2026-07-24.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const FLASH = "deepseek-v4-flash";
export const PRO = "deepseek-v4-pro";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = FLASH;

/** The models offered by `/model`. First entry is the default. */
export const MODELS: ModelChoice[] = [
  { id: FLASH, label: "DeepSeek V4 Flash", description: "fast & cheap — the default" },
  { id: PRO, label: "DeepSeek V4 Pro", description: "stronger, for harder work" },
];

/**
 * The reasoning levels offered by `/think`, which depend on the chosen model.
 * DeepSeek V4 exposes thinking as a toggle on the same model id plus a
 * `reasoning_effort` budget, so the whole space is:
 *
 *   Flash → Standard (no thinking) · Reasoning (thinking, high effort)
 *   Pro   → Standard · High (thinking, high) · Maximum (thinking, max effort)
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (model === PRO) {
    return [
      { label: "Standard", description: "answer directly", thinking: false, effort: "high" },
      { label: "High", description: "deeper step-by-step reasoning", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "xhigh" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Reasoning", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

// DeepSeek list prices (USD / 1M). Cache hits are ~1/10 of misses — the whole
// reason re-sent context stays cheap. `-pro` is estimated higher; correct it if
// needed. These are best-effort defaults a user can override without a rebuild.
const PRICES: Record<string, ModelPrice> = {
  [FLASH]: { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 },
  [PRO]: { cacheHit: 0.028, cacheMiss: 0.28, output: 0.56 },
};
const DEFAULT_PRICE: ModelPrice = PRICES[FLASH]!;

/** Cache-aware list price for a model, falling back to Flash's for unknown ids. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

/**
 * The model's USABLE context window — where retrieval and attention stay reliable,
 * not the raw storage cap. DeepSeek stores 1M tokens but degrades from tool-noise
 * dilution well before that, and on BYOK every token is the user's money, so
 * anchoring compaction here is both more accurate and cheaper.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/**
 * Coerce a stored or unknown config onto a model this driver actually serves, and
 * keep the reasoning intent valid. DeepSeek offers only two of the five shared
 * effort rungs, so anything else clamps to `high`; and Flash has no `xhigh` budget
 * at all, so a Maximum-on-Pro choice steps down when moving to Flash.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = config.model === PRO ? PRO : FLASH;
  const thinking = config.thinking === true;
  // `xhigh` survives only on Pro; every other rung (low/medium/max) becomes high.
  const effort: Effort = config.effort === "xhigh" && model === PRO ? "xhigh" : "high";
  return { model, thinking, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const deepseekManifest: DriverManifest = {
  id: "deepseek",
  label: "DeepSeek",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  keysUrl: "https://platform.deepseek.com/api_keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  normalize,
};
