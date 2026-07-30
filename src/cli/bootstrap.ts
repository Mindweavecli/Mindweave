/**
 * bootstrap.ts — make `mindweave` runnable from any directory.
 *
 * The whole point of a global command is that you `cd` into ANY project, type
 * `mindweave`, and it works — including the API key. A random project won't carry
 * Mindweave's `.env`, so the key has to live somewhere global. We layer config the
 * way every CLI does, lowest priority first:
 *
 *   1. ~/.mindweave/.env   — the global store (write your key here once).
 *   2. <project>/.env  — per-project overrides (optional).
 *   3. real shell env  — always wins (export DEEPSEEK_API_KEY=… for a one-off).
 *
 * We parse `.env` ourselves (a tiny, dependency-free reader) so we control that
 * precedence exactly: a value is only applied if the variable isn't already set,
 * and we load project before global — so shell > project > global falls out
 * naturally. On first run we also drop a commented template at ~/.mindweave/.env so
 * the user has an obvious place to paste their key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The global Mindweave config directory (~/.mindweave). */
export function globalConfigDir(): string {
  return join(homedir(), ".mindweave");
}

/** The global env file (~/.mindweave/.env) — where the API key lives. */
export function globalEnvPath(): string {
  return join(globalConfigDir(), ".env");
}

/**
 * Load configuration into process.env. Call once, before anything reads a key.
 * Order matters: project first, then global, each set-if-absent, so already-set
 * shell variables win and a project `.env` overrides the global one.
 */
export function loadConfig(cwd: string = process.cwd()): void {
  ensureGlobalTemplate();
  reloadConfig(cwd);
}

/**
 * Re-read the env files into process.env without recreating the template. Used to
 * pick up a key the user just pasted while Mindweave is already running — once a real
 * key appears we adopt it with no restart. (Empty values are ignored, so the
 * blank `DEEPSEEK_API_KEY=` line in the fresh template never counts as "set".)
 */
export function reloadConfig(cwd: string = process.cwd()): void {
  applyEnvFile(join(cwd, ".env"));
  applyEnvFile(globalEnvPath());
}

/** True once a DeepSeek key is available from any source. */
export function hasApiKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

/**
 * Persist a key the user typed in the terminal: write it into ~/.mindweave/.env (so
 * it's there next launch too) and apply it to this process right away (so the
 * chat can start immediately — no restart). Updates the existing
 * DEEPSEEK_API_KEY line in place, preserving the rest of the file.
 */
export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  process.env.DEEPSEEK_API_KEY = trimmed;

  const dir = globalConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = globalEnvPath();

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* no file yet */
  }
  const line = `DEEPSEEK_API_KEY=${trimmed}`;
  const next = /^\s*DEEPSEEK_API_KEY=.*$/m.test(existing)
    ? existing.replace(/^\s*DEEPSEEK_API_KEY=.*$/m, line)
    : (existing ? existing.replace(/\s*$/, "\n") : "") + line + "\n";
  writeFileSync(path, next, { mode: 0o600 });
}

/** Create ~/.mindweave/.env with a commented template the first time we run. */
function ensureGlobalTemplate(): void {
  try {
    const dir = globalConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = globalEnvPath();
    if (!existsSync(path)) {
      writeFileSync(
        path,
        "# Mindweave global config — applies in every project.\n" +
          "# Paste your DeepSeek API key below (no quotes needed):\n" +
          "DEEPSEEK_API_KEY=\n" +
          "\n" +
          "# Optional overrides:\n" +
          "# MINDWEAVE_MODEL=deepseek-v4-flash\n" +
          "# MINDWEAVE_BASE_URL=https://api.deepseek.com\n",
        { mode: 0o600 },
      );
    }
  } catch {
    // Best-effort: if we can't write the template, config loading still works.
  }
}

/** Apply a single .env file (set-if-absent), tolerating a missing/garbled file. */
function applyEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no file here — fine
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7) : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key || key in process.env) continue; // already set wins
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // ignore empty assignments (e.g. the blank template line)
    process.env[key] = value;
  }
}
