/**
 * registry.ts — the one place that knows which providers exist.
 *
 * Every other core module reads the driver through `activeDriver()` and never
 * names a provider. That is what keeps the boundary real: if a second file in
 * `dynamo/` or `cli/` ever imports `drivers/<provider>/` directly, the seam has
 * been broken and it will be obvious here.
 *
 * The split that makes this cheap: each provider's MANIFEST (model list, prices,
 * reasoning levels, context window) is plain data and is always loaded, because
 * the `/model` picker and the cost/compaction math need it before anyone has
 * chosen anything. The provider's DRIVER (wire format, SDK, streaming) is behind
 * a dynamic import and loads only once the user actually selects one of its
 * models. So a DeepSeek user never loads Anthropic's SDK, and adding providers
 * doesn't make any single user's startup heavier.
 *
 * The session picks a driver once, at start, and again when `/model` changes the
 * selection — "compile down to one driver" rather than branching per call.
 */
import type { Driver, DriverManifest, ModelChoice, ModelConfig, ModelId } from "./types.js";
import { deepseekManifest } from "./deepseek/manifest.js";
import { anthropicManifest } from "./anthropic/manifest.js";

/** Every provider's cheap metadata, in `/model` display order. Always loaded. */
const MANIFESTS: DriverManifest[] = [deepseekManifest, anthropicManifest];

/** How to load each provider's wire code, on demand. Keyed by manifest id. */
const LOADERS: Record<string, () => Promise<Driver>> = {
  deepseek: async () => (await import("./deepseek/index.js")).deepseekDriver,
  anthropic: async () => (await import("./anthropic/index.js")).anthropicDriver,
};

/** The provider used when a model id doesn't match any other. */
const FALLBACK = MANIFESTS[0]!;

const loaded = new Map<string, Driver>();
let active: Driver | null = null;

/** The manifest that declares a given model id, or the fallback for an unknown id. */
export function manifestForModel(model: ModelId): DriverManifest {
  return MANIFESTS.find((m) => m.models.some((c) => c.id === model)) ?? FALLBACK;
}

/** Every model offered across all installed providers — what `/model` lists. */
export function allModels(): ModelChoice[] {
  return MANIFESTS.flatMap((m) => m.models);
}

/**
 * Coerce a config onto something the owning provider actually serves. Pure and
 * synchronous — it consults only manifests, so the pickers can normalize a
 * selection without loading any provider's wire code.
 */
export function normalizeConfig(config: ModelConfig): ModelConfig {
  return manifestForModel(config.model).normalize(config);
}

/**
 * Load the driver that serves `model` and make it the session's active one.
 * Idempotent and cached, so calling it before every turn costs nothing after the
 * first. This is the only place a provider's wire code is ever loaded.
 */
export async function ensureDriver(model: ModelId): Promise<Driver> {
  const id = manifestForModel(model).id;
  let driver = loaded.get(id);
  if (!driver) {
    const load = LOADERS[id];
    if (!load) throw new Error(`No driver registered for provider '${id}'.`);
    driver = await load();
    loaded.set(id, driver);
  }
  active = driver;
  return driver;
}

/**
 * The driver currently serving this session. Callers reach this only from inside
 * a turn, which `ensureDriver` has already opened — a throw here means someone
 * tried to talk to a model before the session selected one.
 */
export function activeDriver(): Driver {
  if (!active) {
    throw new Error("No model driver is loaded yet — the session must select a model first.");
  }
  return active;
}

/**
 * Normalize streamed text for display: let the active driver repair anything its
 * provider leaked into the text channel, then trim. The trim is deliberately here
 * rather than in a driver — a reply that is only whitespace is an empty reply on
 * every provider, and the display layer treats an empty string as "nothing to
 * show". A driver with no repairs to make (or no driver yet) still gets the trim.
 */
export function sanitizeStreamText(raw: string): string {
  const driver = active;
  const repaired = driver?.sanitizeText ? driver.sanitizeText(raw) : raw;
  return repaired.trim();
}
