/**
 * version.ts — the version shown in the banner, read from package.json.
 *
 * It was a literal in App.tsx, in two places, and it drifted: the banner said
 * v0.0.1 through three releases. That kind of bug cannot fail — it type-checks,
 * every test passes, nothing throws — it is simply false, on screen, every single
 * launch. So the literal goes and there is exactly one source of truth.
 *
 * Read from disk rather than imported, because a JSON import needs an assertion
 * and a resolver flag this build doesn't carry. Read once, cached; a missing or
 * unparseable package.json degrades to no version rather than crashing the UI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | null = null;

/** The package version, e.g. "1.1.2". Empty string if it can't be determined. */
export function appVersion(): string {
  if (cached !== null) return cached;
  cached = "";
  // dist/cli/version.js and src/cli/version.ts are both two levels below the root.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") cached = pkg.version;
  } catch {
    // No package.json (or it's malformed) — show no version rather than a wrong one.
  }
  return cached;
}

/** The banner's tagline, with the version when we know it. */
export function versionLabel(): string {
  const v = appVersion();
  return v ? ` — terminal coding agent (v${v})` : " — terminal coding agent";
}
