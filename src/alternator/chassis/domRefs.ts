/**
 * domRefs.ts — pull DOM class/id references out of JavaScript (pure, regex).
 *
 * A page wires HTML/CSS/JS by literal name: `document.getElementById("hero")`,
 * `querySelector(".hero-stats")`, `classList.add("active")`. These are the JS half
 * of a cross-language string wire — extracting them as name-level references lets
 * the graph connect a CSS rule / HTML element to the script that manipulates it.
 * These names feed Mindweave's name-keyed def/ref graph, so `references(".hero")`
 * includes the script that touches it.
 *
 * Deliberately conservative: ONLY well-known DOM selector APIs, so an arbitrary
 * string literal never becomes graph noise. Pure + line-based (unit-tested).
 */

export interface DomRef {
  name: string;
  line: number; // 1-based, plus `lineOffset`
}

// Capture group 1 is the class/id name (a leading `.`/`#` is stripped). querySelector
// takes a full selector, so we grab just its first simple token — enough to wire it.
const PATTERNS: readonly RegExp[] = [
  /\bgetElementById\(\s*['"`]([#.]?[A-Za-z_][\w-]*)['"`]/g,
  /\bgetElementsByClassName\(\s*['"`]([#.]?[A-Za-z_][\w-]*)['"`]/g,
  /\bquerySelector(?:All)?\(\s*['"`]([#.]?[A-Za-z_][\w-]*)/g,
  /\bclassList\.(?:add|remove|toggle|contains|replace)\(\s*['"`]([A-Za-z_][\w-]*)['"`]/g,
];

/** DOM class/id names referenced in `code`. `lineOffset` shifts the reported line
 *  (used when the code is an embedded `<script>` block inside an HTML file). */
export function extractDomRefs(code: string, lineOffset = 0): DomRef[] {
  const out: DomRef[] = [];
  const seen = new Set<string>();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const name = m[1]!.replace(/^[#.]/, "").trim();
      if (!name) continue;
      const line = lineAt(code, m.index) + lineOffset;
      const key = `${name}@${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, line });
    }
  }
  return out;
}

/** The 1-based line a character offset falls on. */
function lineAt(code: string, index: number): number {
  let line = 1;
  const limit = Math.min(index, code.length);
  for (let i = 0; i < limit; i++) if (code[i] === "\n") line++;
  return line;
}
