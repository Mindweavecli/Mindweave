/**
 * spanCore.ts — pure line-span helpers for reading/replacing a symbol's body.
 *
 * The two symbol tools (read_symbol, replace_symbol_body) need to turn a symbol
 * into a range of lines and then slice or splice that range. All of that math is
 * kept here — string/number in, string/number out, no fs, no tree-sitter — so it
 * is unit-tested once and both tools (and the chassis's LSP `documentSymbol`
 * reader) inherit the same, verified behavior. Deciding WHICH symbol to touch is
 * the model's job; this module only does the mechanical slicing.
 */

/** A 1-based, inclusive line range. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A flattened LSP symbol with its full line range (1-based, inclusive). */
export interface FlatDocSymbol {
  name: string;
  start: number;
  end: number;
}

/**
 * The raw shape of an LSP `documentSymbol` result item. Servers return one of two
 * shapes: hierarchical `DocumentSymbol` (has `range` + `children`) or flat
 * `SymbolInformation` (has `location.range`, no children). We read whichever is
 * present, so a span is recovered from either kind of server.
 */
export interface RawDocSymbol {
  name?: string;
  range?: { start?: { line?: number }; end?: { line?: number } };
  location?: { range?: { start?: { line?: number }; end?: { line?: number } } };
  children?: RawDocSymbol[];
}

/** Flatten a (possibly nested) documentSymbol tree to name + 1-based line range. */
export function flattenDocSymbols(raw: readonly RawDocSymbol[] | null | undefined): FlatDocSymbol[] {
  const out: FlatDocSymbol[] = [];
  const visit = (nodes: readonly RawDocSymbol[] | undefined): void => {
    for (const n of nodes ?? []) {
      const r = n.range ?? n.location?.range;
      const name = typeof n.name === "string" ? n.name : "";
      if (name && typeof r?.start?.line === "number" && typeof r?.end?.line === "number") {
        out.push({ name, start: r.start.line + 1, end: r.end.line + 1 });
      }
      if (n.children && n.children.length) visit(n.children);
    }
  };
  visit(raw ?? []);
  return out;
}

/**
 * Pick the span whose start line is nearest `nearLine` (used to disambiguate
 * overloads / same-named symbols in one file). With no hint, the first span.
 */
export function pickNearest(spans: readonly LineSpan[], nearLine?: number): LineSpan | null {
  if (spans.length === 0) return null;
  if (nearLine === undefined) return spans[0]!;
  return spans.reduce((best, s) =>
    Math.abs(s.start - nearLine) < Math.abs(best.start - nearLine) ? s : best,
  );
}

/** Split on CRLF or LF so line math is identical regardless of the file's EOL. */
function toLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * The lines [start..end] (1-based, inclusive) of `content`, line-numbered like
 * read_file. Clamped to the file's real bounds so a slightly-too-long span never
 * throws.
 */
export function sliceBody(content: string, start: number, end: number): string {
  const lines = toLines(content);
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(width)}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

/** The raw text (no line numbers) of lines [start..end], for a diff or backup. */
export function rawLines(content: string, start: number, end: number): string {
  const lines = toLines(content);
  return lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join("\n");
}

/**
 * Replace lines [start..end] (1-based, inclusive) of `content` with `replacement`.
 * Operates on LF-normalized text (the caller re-applies the file's real EOL). The
 * range is clamped to the file's bounds so an over-long end can't drop trailing
 * content it didn't mean to.
 */
export function spliceLines(content: string, start: number, end: number, replacement: string): string {
  const lines = toLines(content);
  const repl = replacement.replace(/\r\n/g, "\n").split("\n");
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);
  const before = lines.slice(0, from - 1);
  const after = lines.slice(to);
  return [...before, ...repl, ...after].join("\n");
}
