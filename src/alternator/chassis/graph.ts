/**
 * graph.ts — the in-memory code graph (pure, dependency-free).
 *
 * Sources (tree-sitter, LSP) feed defs and refs into this; the chassis queries
 * read out of it. It's deliberately storage-agnostic and free of I/O so it's
 * trivially testable and could run on either side of the future client/server
 * line. Confidence is derived from which files an LSP has resolved: a fact about
 * a file an LSP analyzed is `resolved`, otherwise `name-level`.
 */
import {
  asFileId,
  type Confidence,
  type FileId,
  type OutlineEntry,
  type Ref,
  type SymbolId,
  type SymbolKind,
  type SymbolNode,
} from "./types.js";

export class CodeGraph {
  private symbols = new Map<SymbolId, SymbolNode>();
  private byName = new Map<string, SymbolId[]>();
  private byFile = new Map<FileId, SymbolId[]>();
  /** References keyed by the referenced name (tree-sitter refs are name-level). */
  private refsByName = new Map<string, Ref[]>();
  /** Import edges: a file → the in-repo files it imports (resolved relative specs). */
  private importsByFile = new Map<FileId, Set<FileId>>();
  /** The reverse: a file → the files that import it. */
  private importedByFile = new Map<FileId, Set<FileId>>();
  /** Files an LSP has analyzed — facts about these are `resolved`. */
  private resolvedFiles = new Set<FileId>();

  /** Drop everything recorded for a file (used when re-parsing a changed file). */
  clearFile(file: FileId): void {
    const ids = this.byFile.get(file) ?? [];
    for (const id of ids) {
      const node = this.symbols.get(id);
      this.symbols.delete(id);
      if (node) {
        const named = this.byName.get(node.name);
        if (named) {
          const left = named.filter((x) => x !== id);
          if (left.length) this.byName.set(node.name, left);
          else this.byName.delete(node.name);
        }
      }
    }
    this.byFile.delete(file);
    // Drop refs originating in this file.
    for (const [name, refs] of this.refsByName) {
      const left = refs.filter((r) => r.file !== file);
      if (left.length) this.refsByName.set(name, left);
      else this.refsByName.delete(name);
    }
    // Drop this file's OUTGOING import edges (incoming ones belong to other files
    // and are re-added when those files are re-indexed).
    const outgoing = this.importsByFile.get(file);
    if (outgoing) {
      for (const to of outgoing) this.importedByFile.get(to)?.delete(file);
      this.importsByFile.delete(file);
    }
    this.resolvedFiles.delete(file);
  }

  addSymbol(node: SymbolNode): void {
    this.symbols.set(node.id, node);
    push(this.byName, node.name, node.id);
    push(this.byFile, node.file, node.id);
  }

  addRef(name: string, ref: Ref): void {
    push(this.refsByName, name, ref);
  }

  /** Record that `from` imports `to` (both in-repo, resolved). */
  addImport(from: FileId, to: FileId): void {
    if (from === to) return;
    addToSet(this.importsByFile, from, to);
    addToSet(this.importedByFile, to, from);
  }

  /** The in-repo files a file imports. */
  dependencies(file: FileId): FileId[] {
    return [...(this.importsByFile.get(file) ?? [])];
  }

  /** The in-repo files that import a file. */
  dependents(file: FileId): FileId[] {
    return [...(this.importedByFile.get(file) ?? [])];
  }

  /** All import edges as [from, to[]] pairs — for cache + cross-root merging. */
  allImports(): [FileId, FileId[]][] {
    return [...this.importsByFile.entries()].map(([from, tos]) => [from, [...tos]]);
  }

  markResolved(file: FileId): void {
    this.resolvedFiles.add(file);
  }

  // ── queries ─────────────────────────────────────────────────────────────
  definition(name: string): { symbols: SymbolNode[]; confidence: Confidence } {
    const ids = this.byName.get(name) ?? [];
    const symbols = ids.map((id) => this.symbols.get(id)!).filter(Boolean);
    return { symbols, confidence: this.confidenceFor(symbols.map((s) => s.file)) };
  }

  references(name: string): { refs: Ref[]; confidence: Confidence } {
    const refs = this.refsByName.get(name) ?? [];
    return { refs, confidence: this.confidenceFor(refs.map((r) => r.file)) };
  }

  /** Nested outline of one file: symbols nested by definition-span containment
   *  (a method sits under its class), each carrying its signature + doc. */
  outlineForFile(file: FileId): OutlineEntry[] {
    const ids = this.byFile.get(file) ?? [];
    const symbols = ids.map((id) => this.symbols.get(id)!).filter(Boolean);
    return nestOutline(symbols);
  }

  /** Files whose path starts with `dirPrefix` (posix), for directory outlines. */
  filesUnder(dirPrefix: string): FileId[] {
    const prefix = dirPrefix.endsWith("/") ? dirPrefix : dirPrefix + "/";
    return [...this.byFile.keys()].filter((f) => f === dirPrefix || f.startsWith(prefix));
  }

  allSymbols(): SymbolNode[] {
    return [...this.symbols.values()];
  }

  symbolsInFile(file: FileId): SymbolNode[] {
    return (this.byFile.get(file) ?? []).map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  /** All recorded references, keyed by name — used by ranking. */
  allRefs(): ReadonlyMap<string, readonly Ref[]> {
    return this.refsByName;
  }

  byNameMap(): ReadonlyMap<string, readonly SymbolId[]> {
    return this.byName;
  }

  getSymbol(id: SymbolId): SymbolNode | undefined {
    return this.symbols.get(id);
  }

  counts(): { files: number; symbols: number } {
    return { files: this.byFile.size, symbols: this.symbols.size };
  }

  private confidenceFor(files: FileId[]): Confidence {
    // Resolved only if every relevant file was LSP-analyzed; any tree-sitter-only
    // file drops the whole answer to name-level (honest — we can't claim more).
    return files.length > 0 && files.every((f) => this.resolvedFiles.has(f))
      ? "resolved"
      : "name-level";
  }
}

/**
 * Merge several roots' graphs into one for cross-root analysis. Because symbols and
 * refs are keyed by NAME (and symbol ids embed the absolute file path, so they're
 * unique across roots), the union automatically links a reference in one root to a
 * definition in another — which is exactly what lets relevance/PageRank flow across
 * folders (frontend → backend). Pure: the inputs are untouched.
 */
export function combineGraphs(graphs: readonly CodeGraph[]): CodeGraph {
  const merged = new CodeGraph();
  for (const g of graphs) {
    for (const sym of g.allSymbols()) merged.addSymbol(sym);
    for (const [name, refs] of g.allRefs()) for (const ref of refs) merged.addRef(name, ref);
    for (const [from, tos] of g.allImports()) for (const to of tos) merged.addImport(from, to);
  }
  return merged;
}

interface MutableEntry {
  name: string;
  kind: SymbolKind;
  line: number;
  end: number;
  signature?: string;
  doc?: string;
  kids: MutableEntry[];
}

/**
 * Nest a file's symbols by definition-span containment: a symbol whose [line..end]
 * falls inside another's becomes its child (a method under its class). Pure and
 * exported for tests. Symbols with no end line (single-line defs, or facts from a
 * source that didn't record a span) simply never gain children.
 */
export function nestOutline(symbols: readonly SymbolNode[]): OutlineEntry[] {
  // Containers before contents: earliest start first, and for a tie the wider span.
  const sorted = [...symbols].sort((a, b) => a.line - b.line || endOf(b) - endOf(a));
  const roots: MutableEntry[] = [];
  const stack: MutableEntry[] = [];
  for (const s of sorted) {
    const entry: MutableEntry = {
      name: s.name,
      kind: s.kind,
      line: s.line,
      end: endOf(s),
      signature: s.signature,
      doc: s.doc,
      kids: [],
    };
    while (stack.length && !encloses(stack[stack.length - 1]!, entry)) stack.pop();
    (stack.length ? stack[stack.length - 1]!.kids : roots).push(entry);
    stack.push(entry);
  }
  return roots.map(freezeEntry);
}

function endOf(s: SymbolNode): number {
  return s.endLine ?? s.line;
}

/** True if `container` strictly spans `s` (and isn't `s` itself). */
function encloses(container: MutableEntry, s: MutableEntry): boolean {
  if (container.line === s.line && container.end === s.end) return false;
  return container.line <= s.line && container.end >= s.end;
}

function freezeEntry(e: MutableEntry): OutlineEntry {
  return {
    name: e.name,
    kind: e.kind,
    line: e.line,
    ...(e.signature ? { signature: e.signature } : {}),
    ...(e.doc ? { doc: e.doc } : {}),
    ...(e.kids.length ? { children: e.kids.map(freezeEntry) } : {}),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

export { asFileId, type FileId, type SymbolKind };
