/**
 * frontmatter.ts — a tiny YAML-frontmatter reader for governor files.
 *
 * Rules and skills are plain markdown with a small `--- … ---` header, the same
 * shape widely used for agent rules and skills. We
 * only need flat `key: value` pairs, so this is a deliberately minimal parser —
 * no YAML dependency, no nesting, no lists. Anything fancier than `key: value`
 * is ignored rather than erroring, so a hand-edited file never breaks loading.
 */

export interface Frontmatter {
  /** The parsed `key: value` header (empty object when there's no header). */
  data: Record<string, string>;
  /** Everything after the header, trimmed — the rule/skill body. */
  body: string;
}

/** Split a markdown file into its frontmatter header and body. */
export function parseFrontmatter(raw: string): Frontmatter {
  // Strip a UTF-8 BOM so a `---` on line 1 is still recognized.
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text.trim() };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Unwrap a single layer of surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }

  return { data, body: text.slice(match[0].length).trim() };
}
