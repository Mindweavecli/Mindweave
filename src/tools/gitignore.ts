/**
 * gitignore.ts — honour .gitignore in the pure-Node walk.
 *
 * WHY THIS EXISTS: search has two engines. ripgrep walks the tree itself and is
 * .gitignore-aware; the Node fallback in walk.ts was not. So the same query
 * returned different results depending on whether `rg` happened to be installed,
 * and both tool descriptions stated the gitignore behaviour as universal — true on
 * one engine, false on the other. Two engines that disagree about what exists is
 * worse than either behaviour on its own, because nothing in the answer says which
 * one you got.
 *
 * WHAT IS SUPPORTED (the common subset, which is what real .gitignore files use):
 *   - comments (`#`), blank lines, trailing-space trimming
 *   - negation (`!pattern`), last match wins, deeper files override shallower ones
 *   - directory-only rules (`build/`)
 *   - anchoring: a `/` anywhere but the end anchors to the .gitignore's own
 *     directory; otherwise the rule matches a basename at any depth
 *   - `*`, `?`, `**`, and backslash escapes
 *
 * NOT supported, deliberately: character classes (`[a-z]`). They are rare in real
 * ignore files, and a half-right implementation of them would silently hide files,
 * which is the one failure mode worth avoiding here — an unsupported rule is
 * treated as matching nothing, so the walk errs toward SHOWING a file rather than
 * hiding it. Over-showing is visible and correctable; over-hiding looks like the
 * file does not exist.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface IgnoreRule {
  /** Anchored regex tested against a path relative to the rule's base directory. */
  re: RegExp;
  /** `!rule` — re-includes a path an earlier rule excluded. */
  negated: boolean;
  /** `build/` — only matches directories. */
  dirOnly: boolean;
}

/** The rules from one .gitignore, plus the directory they are relative to. */
export interface IgnoreLayer {
  /** Directory containing the .gitignore, as an absolute path. */
  base: string;
  rules: IgnoreRule[];
}

/** Parse .gitignore text into rules. Exported for testing. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    // A comment only counts at the start; `foo#bar` is a real pattern.
    if (line.startsWith("#")) continue;
    // Trailing whitespace is stripped unless escaped with a backslash.
    line = line.replace(/(?<!\\)\s+$/, "");
    if (line === "") continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!")) {
      line = line.slice(1); // an escaped literal "!"
    }
    if (line === "") continue;

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === "") continue;

    // A slash anywhere except the very end anchors the rule to this .gitignore's
    // directory. Otherwise it matches a basename at any depth.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);

    const body = globBody(line);
    if (body === null) continue; // unsupported syntax — match nothing (see header)
    const prefix = anchored ? "" : "(?:.*/)?";
    rules.push({ re: new RegExp(`^${prefix}${body}$`), negated, dirOnly });
  }
  return rules;
}

/** Translate one gitignore pattern into a regex body, or null if unsupported. */
function globBody(pattern: string): string | null {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return null; // dangling escape
      out += escapeRe(next);
      i++;
    } else if (c === "[") {
      return null; // character class — deliberately unsupported, see header
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans zero or more whole segments; a trailing `**` matches the rest.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read a directory's .gitignore into a layer, or null when it has none. */
export async function loadIgnoreLayer(dir: string): Promise<IgnoreLayer | null> {
  let text: string;
  try {
    text = await fs.readFile(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const rules = parseGitignore(text);
  return rules.length ? { base: dir, rules } : null;
}

/**
 * Is `relPath` (posix, relative to the layer's base) ignored by these layers?
 *
 * Git's precedence: a deeper .gitignore overrides a shallower one, and within one
 * file the LAST matching rule wins. So we walk layers deepest-first and return the
 * first layer that has an opinion.
 */
export function isIgnored(
  layers: readonly { layer: IgnoreLayer; rel: string }[],
  isDir: boolean,
): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    const { layer, rel } = layers[i];
    let decision: boolean | null = null;
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rel)) decision = !rule.negated;
    }
    if (decision !== null) return decision;
  }
  return false;
}
