/**
 * model.ts — which model answers, and how hard it thinks.
 *
 * One small config object decides both: `/model` picks the model, `/think` picks
 * the reasoning level for that model. What those choices ARE is the driver's
 * business (each provider exposes reasoning differently); this module owns only
 * the parts that are the same for every provider — the shape of the config, the
 * labels the UI renders, and making the choice sticky.
 *
 * The choice is sticky PER PROJECT (saved under the project's state dir, like
 * sessions and the governor), so it carries across sessions in that project.
 * Loading a config also selects the driver that serves it, so the rest of the
 * session talks to the right provider without ever naming one.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";
import { allModels, ensureDriver, manifestForModel, normalizeConfig } from "../drivers/registry.js";
import type { Effort, ModelChoice, ModelConfig, ModelId, ThinkLevel } from "../drivers/types.js";

export type { Effort, ModelChoice, ModelConfig, ModelId, ThinkLevel };

/** The models offered by `/model`, across every installed provider. */
export const MODELS: ModelChoice[] = allModels();

/** The out-of-the-box choice: the first offered model, no thinking. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = normalizeConfig({
  model: MODELS[0]!.id,
  thinking: false,
  effort: "high",
});

/** The reasoning levels offered by `/think` for a model. */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  return manifestForModel(model).thinkLevels(model);
}

/** The label of the reasoning level a config currently represents. */
export function thinkLabel(cfg: ModelConfig): string {
  const match = thinkLevels(cfg.model).find(
    (l) => l.thinking === cfg.thinking && (!l.thinking || l.effort === cfg.effort),
  );
  return match?.label ?? "Standard";
}

/** The model's display name (for status lines / confirmations). */
export function modelLabel(model: ModelId): string {
  return MODELS.find((m) => m.id === model)?.label ?? model;
}

/**
 * Switch the model, letting the owning provider keep the reasoning intent valid
 * (a level the target model doesn't offer is clamped down rather than sent and
 * rejected). Synchronous: it consults only manifests. The provider's wire code is
 * loaded separately, by `ensureDriver`, before the next turn runs.
 */
export function withModel(cfg: ModelConfig, model: ModelId): ModelConfig {
  return normalizeConfig({ ...cfg, model });
}

function configPath(projectCwd: string): string {
  return join(projectDir(projectCwd), "model.json");
}

/**
 * Load the project's saved model config, or the default when none is saved, and
 * load the provider that serves it — this is where a session's provider gets
 * decided, and the only place its wire code comes off disk.
 */
export async function loadModelConfig(projectCwd: string): Promise<ModelConfig> {
  let config: ModelConfig;
  try {
    const raw = await fs.readFile(configPath(projectCwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    config = normalizeConfig({
      model: parsed.model ?? DEFAULT_MODEL_CONFIG.model,
      thinking: parsed.thinking === true,
      effort: parsed.effort ?? "high",
    });
  } catch {
    config = { ...DEFAULT_MODEL_CONFIG };
  }
  await ensureDriver(config.model);
  return config;
}

/** Persist the project's model config (best-effort; never throws). */
export async function saveModelConfig(projectCwd: string, cfg: ModelConfig): Promise<void> {
  try {
    await fs.mkdir(projectDir(projectCwd), { recursive: true });
    await fs.writeFile(configPath(projectCwd), JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}
