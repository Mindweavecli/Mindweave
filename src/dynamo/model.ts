/**
 * model.ts — which model answers, and how hard it thinks.
 *
 * One small config object decides both: `/model` picks the model, `/think` picks
 * the reasoning level for that model. DeepSeek V4 exposes thinking as a toggle on
 * the same model id plus a `reasoning_effort` budget, so the whole space is:
 *
 *   Flash → Standard (no thinking) · Reasoning (thinking, high effort)
 *   Pro   → Standard · High (thinking, high) · Maximum (thinking, max effort)
 *
 * The choice is sticky PER PROJECT (saved under the project's state dir, like
 * sessions and the governor), so it carries across sessions in that project. The
 * provider client (deepseek.ts) turns this into the request body; the pickers in
 * the CLI render from the same level tables — one source of truth.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";

export type ModelId = "deepseek-v4-flash" | "deepseek-v4-pro";

/** Effort budget sent in thinking mode. `xhigh` maps to the provider's max. */
export type Effort = "high" | "xhigh";

export interface ModelConfig {
  model: ModelId;
  thinking: boolean;
  /** Only meaningful when `thinking` is true. */
  effort: Effort;
}

/** Flash, no thinking — fast and cheap, the out-of-the-box default. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "deepseek-v4-flash",
  thinking: false,
  effort: "high",
};

export interface ModelChoice {
  id: ModelId;
  label: string;
  description: string;
}

/** The models offered by `/model`. */
export const MODELS: ModelChoice[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "fast & cheap — the default" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "stronger, for harder work" },
];

export interface ThinkLevel {
  label: string;
  description: string;
  thinking: boolean;
  effort: Effort;
}

/** The reasoning levels offered by `/think`, which depend on the chosen model. */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (model === "deepseek-v4-flash") {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
      { label: "Reasoning", description: "think first, then answer", thinking: true, effort: "high" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly", thinking: false, effort: "high" },
    { label: "High", description: "deeper step-by-step reasoning", thinking: true, effort: "high" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "xhigh" },
  ];
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
 * Switch the model while keeping the reasoning intent valid: Flash has no `xhigh`
 * level, so a Maximum-on-Pro choice clamps to high when moving to Flash.
 */
export function withModel(cfg: ModelConfig, model: ModelId): ModelConfig {
  const next: ModelConfig = { ...cfg, model };
  if (model === "deepseek-v4-flash" && next.thinking) next.effort = "high";
  return next;
}

function configPath(projectCwd: string): string {
  return join(projectDir(projectCwd), "model.json");
}

/** Load the project's saved model config, or the default when none is saved. */
export async function loadModelConfig(projectCwd: string): Promise<ModelConfig> {
  try {
    const raw = await fs.readFile(configPath(projectCwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    const model: ModelId = parsed.model === "deepseek-v4-pro" ? "deepseek-v4-pro" : "deepseek-v4-flash";
    const thinking = parsed.thinking === true;
    const effort: Effort = parsed.effort === "xhigh" ? "xhigh" : "high";
    return { model, thinking, effort };
  } catch {
    return { ...DEFAULT_MODEL_CONFIG };
  }
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
