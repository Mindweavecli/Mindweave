/**
 * markdown.ts — render Mindweave's markdown replies as styled terminal text.
 *
 * Mindweave's model answers in markdown (`# headings`, `**bold**`, `- lists`,
 * ```code```), which looked raw in the terminal. This turns that into an ANSI
 * string that Ink renders directly inside a <Text> (Ink passes ANSI through and
 * wraps it correctly). The pipeline is straightforward: `marked` lexes to tokens,
 * a small walker emits `chalk`-styled ANSI, and fenced code goes through
 * `cli-highlight` (highlight.js) — all written here from scratch, kept compact.
 *
 * Notes:
 *  - Strikethrough is intentionally disabled: models use `~` for "approx" (~100),
 *    not actual strikethrough.
 *  - Syntax highlighting degrades to dim plain text when the language isn't known
 *    or the highlighter is unavailable, so rendering never throws.
 */
import { createRequire } from "node:module";
import chalk from "chalk";
import { marked, type Token, type Tokens } from "marked";

const ESC = String.fromCharCode(27); // the ANSI escape byte, built to avoid embedding it in source

// cli-highlight is loaded defensively — if it (or highlight.js) fails to resolve,
// code blocks fall back to dim plain text rather than breaking all rendering.
// It's CJS, so a createRequire keeps the load synchronous (renderMarkdown can't await).
type Highlighter = {
  highlight: (code: string, opts: { language: string; ignoreIllegals?: boolean }) => string;
  supportsLanguage: (lang: string) => boolean;
};
let highlighter: Highlighter | null = null;
try {
  highlighter = createRequire(import.meta.url)("cli-highlight") as Highlighter;
} catch {
  highlighter = null;
}

let configured = false;
function configure(): void {
  if (configured) return;
  configured = true;
  // Drop strikethrough parsing — `~approx` is almost never intended as <del>.
  marked.use({ tokenizer: { del: () => undefined } });
}

// The visible columns available to the renderer, set per call. Used to fit tables
// so a wide one never exceeds the width (which makes Ink wrap each line and shatter
// the box). Module-level because renderMarkdown is synchronous and single-threaded.
let tableWidth = 80;

/** Render a markdown string to a styled ANSI string for an Ink <Text>. `width` is
 *  the visible columns available; tables are sized to fit inside it. */
export function renderMarkdown(content: string, width = 80): string {
  configure();
  tableWidth = Math.max(20, width);
  try {
    return marked
      .lexer(content)
      .map((t) => renderToken(t, 0, null))
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return content; // never let a parse error swallow the reply
  }
}

const BULLET = "•";

function renderToken(token: Token, depth: number, ordered: number | null): string {
  switch (token.type) {
    case "heading": {
      const text = inline(token.tokens);
      const styled = token.depth === 1 ? chalk.bold.underline(text) : chalk.bold(text);
      return styled + "\n\n";
    }
    case "paragraph":
      return inline(token.tokens) + "\n\n";
    case "text": {
      const t = token as Tokens.Text;
      return t.tokens ? inline(t.tokens) : decodeEntities(t.text);
    }
    case "code":
      return renderCodeBlock(token as Tokens.Code) + "\n";
    case "blockquote": {
      const inner = (token.tokens ?? []).map((t) => renderToken(t, 0, null)).join("").trim();
      return (
        inner
          .split("\n")
          .map((line) => chalk.dim("│ ") + chalk.italic(line))
          .join("\n") + "\n\n"
      );
    }
    case "list": {
      const list = token as Tokens.List;
      return (
        list.items
          .map((item, i) => renderListItem(item, depth, list.ordered ? Number(list.start) + i : null))
          .join("") + (depth === 0 ? "\n" : "")
      );
    }
    case "hr":
      return chalk.dim("─".repeat(24)) + "\n\n";
    case "table":
      // A blank line below (like paragraphs) so the next section doesn't hug the
      // table's last row — the collapse in renderMarkdown trims any excess.
      return renderTable(token as Tokens.Table) + "\n\n";
    case "space":
      return "\n";
    case "html":
    case "def":
      return "";
    default:
      return "text" in token ? (token as { text: string }).text : "";
  }
}

/** One list item, indented by depth, with a bullet or its number. */
function renderListItem(item: Tokens.ListItem, depth: number, ordered: number | null): string {
  const indent = "  ".repeat(depth);
  const marker = ordered === null ? chalk.dim(BULLET) : chalk.dim(`${ordered}.`);
  // An item's children are usually a "text" token plus possibly nested lists.
  let head = "";
  let rest = "";
  for (const child of item.tokens ?? []) {
    if (child.type === "list") {
      rest += renderToken(child, depth + 1, null);
    } else if (child.type === "text") {
      const t = child as Tokens.Text;
      head += t.tokens ? inline(t.tokens) : decodeEntities(t.text);
    } else {
      head += renderToken(child, depth, null);
    }
  }
  return `${indent}${marker} ${head.trim()}\n${rest}`;
}

/** Inline tokens (the children of a paragraph/heading/list item). */
function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map(inlineToken).join("");
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case "strong":
      return chalk.bold(inline((token as Tokens.Strong).tokens));
    case "em":
      return chalk.italic(inline((token as Tokens.Em).tokens));
    case "codespan":
      return chalk.cyan(decodeEntities((token as Tokens.Codespan).text));
    case "link": {
      const l = token as Tokens.Link;
      const text = decodeEntities(inline(l.tokens) || l.href);
      const shown = chalk.cyan.underline(text);
      // Show the URL only when it differs from the link text. No OSC-8 escapes —
      // they render as garbage in terminals that don't support them.
      return l.href && l.href !== text ? `${shown} ${chalk.dim(`(${l.href})`)}` : shown;
    }
    case "br":
      return "\n";
    case "escape":
      return decodeEntities((token as Tokens.Escape).text);
    case "text":
      return decodeEntities((token as Tokens.Text).text);
    default:
      return "text" in token ? decodeEntities((token as { text: string }).text) : "";
  }
}

// marked HTML-escapes text tokens (& < > " '). Decode them for the terminal.
// &amp; is decoded last so an encoded entity like &amp;lt; doesn't double-decode.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
}

/** A fenced code block: syntax-highlighted if possible, else dim, indented 2. */
function renderCodeBlock(token: Tokens.Code): string {
  let body: string;
  const lang = (token.lang || "").trim().split(/\s+/)[0];
  if (highlighter && lang && safeSupports(lang)) {
    try {
      body = highlighter.highlight(token.text, { language: lang, ignoreIllegals: true });
    } catch {
      body = chalk.dim(token.text);
    }
  } else {
    body = chalk.dim(token.text);
  }
  return body
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
}

function safeSupports(lang: string): boolean {
  try {
    return highlighter!.supportsLanguage(lang);
  } catch {
    return false;
  }
}

// Strips SGR color codes (for plain-text cell measurement/wrapping).
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Pad a plain string to width w with trailing spaces. */
function padCell(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Greedy word-wrap of PLAIN text to `width`, hard-breaking any word longer than it. */
function wrapPlain(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Shrink the widest columns one at a time until the row fits the content budget. */
function fitColumns(natural: number[], budget: number): number[] {
  const widths = natural.map((w) => Math.max(1, w));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let idx = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[idx]) idx = i;
    if (widths[idx] <= 1) break; // nothing left to shrink
    widths[idx]--;
    total--;
  }
  return widths;
}

// The gutter between columns: a dim thin rule with a space either side. Light
// enough not to box the content in, but it keeps the columns visually separated
// (and wrapped continuation lines aligned under their column).
const COL_GUTTER = " │ ";
const GUTTER_WIDTH = COL_GUTTER.length; // 3 columns

/**
 * A clean monospace table that always fits the available width. The old renderer
 * drew a full ASCII box (outer border + a ├─┼─┤ rule between every row), which
 * read as cramped and busy in the terminal — especially once cells wrapped. This
 * is airier: a bold header, ONE dim rule beneath it, and dim thin column
 * separators — no outer border and no per-row grid. Columns are sized to their
 * content, then the widest are shrunk and word-wrapped so a long cell stacks onto
 * several lines instead of overflowing. Cell contents render plain (inline styling
 * dropped) so wrapping and alignment stay exact.
 */
function renderTable(token: Tokens.Table): string {
  const headers = token.header.map((c) => stripAnsi(inline(c.tokens)));
  const n = headers.length;
  if (n === 0) return "";
  const rows = token.rows.map((r) => headers.map((_, i) => stripAnsi(inline(r[i]?.tokens ?? []))));

  const natural = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length), 1));
  // Columns are joined by the gutter (no outer border), so the separators between
  // n columns cost GUTTER_WIDTH*(n-1). Leave one trailing column as breathing room.
  const budget = Math.max(n, tableWidth - GUTTER_WIDTH * (n - 1) - 1);
  const widths = fitColumns(natural, budget);

  const gutter = chalk.dim(COL_GUTTER);
  const renderRow = (cells: string[], header: boolean): string => {
    const wrapped = cells.map((c, i) => wrapPlain(c, widths[i]));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let row = 0; row < height; row++) {
      const line = wrapped.map((w, i) => padCell(w[row] ?? "", widths[i])).join(gutter);
      out.push(header ? chalk.bold(line) : line);
    }
    return out.join("\n");
  };

  // A single continuous rule under the header, spanning the table's full width.
  const total = widths.reduce((a, b) => a + b, 0) + GUTTER_WIDTH * (n - 1);
  const rule = chalk.dim("─".repeat(total));
  return [renderRow(headers, true), rule, ...rows.map((r) => renderRow(r, false))].join("\n");
}
