/**
 * rank.ts — personalized PageRank over the reference graph (pure).
 *
 * The insight: not all symbols matter equally — one called by twenty others
 * is more valuable context than a private helper. We rank symbols by structural
 * centrality, then *personalize* the walk toward the files the model is currently
 * working on, so "what's relevant here" is precise rather than a dump.
 *
 * Edges: a reference (in file F) to a name N produces edges from every symbol
 * DEFINED in F to every symbol named N — i.e. "the code in F depends on N". Hub
 * symbols (depended on widely) accumulate rank.
 */
import { CodeGraph } from "./graph.js";
import type { FileId, RankedSymbol, SymbolId } from "./types.js";

const DAMPING = 0.85;
const ITERATIONS = 30;
const FOCUS_BOOST = 25; // restart weight for symbols in the focus files
// Guard against pathological repos: skip ranking past this many symbols (the
// caller falls back to a cheaper heuristic). Tunable later.
const MAX_NODES = 50_000;

export function rankSymbols(
  graph: CodeGraph,
  focusFiles: readonly FileId[],
  limit: number,
): RankedSymbol[] {
  const nodes = graph.allSymbols();
  const n = nodes.length;
  if (n === 0 || n > MAX_NODES) return [];

  const index = new Map<SymbolId, number>();
  nodes.forEach((node, i) => index.set(node.id, i));

  // Build out-adjacency: referrer-symbol → referenced-symbol.
  const out: number[][] = Array.from({ length: n }, () => []);
  const byName = graph.byNameMap();
  for (const [name, refs] of graph.allRefs()) {
    const targets = (byName.get(name) ?? [])
      .map((id) => index.get(id))
      .filter((i): i is number => i !== undefined);
    if (targets.length === 0) continue;
    for (const ref of refs) {
      for (const referrer of graph.symbolsInFile(ref.file)) {
        const ri = index.get(referrer.id);
        if (ri === undefined) continue;
        for (const t of targets) if (t !== ri) out[ri].push(t);
      }
    }
  }

  // Personalization vector: boost symbols defined in the focus files.
  const focus = new Set<FileId>(focusFiles);
  const pers = new Float64Array(n);
  let persSum = 0;
  for (let i = 0; i < n; i++) {
    const w = focus.has(nodes[i].file) ? FOCUS_BOOST : 1;
    pers[i] = w;
    persSum += w;
  }
  for (let i = 0; i < n; i++) pers[i] /= persSum;

  // Power iteration.
  let rank = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) next[i] = (1 - DAMPING) * pers[i];
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const edges = out[i];
      if (edges.length === 0) {
        dangling += rank[i];
        continue;
      }
      const share = (DAMPING * rank[i]) / edges.length;
      for (const t of edges) next[t] += share;
    }
    // Dangling mass redistributed along the personalization vector.
    for (let i = 0; i < n; i++) next[i] += DAMPING * dangling * pers[i];
    rank = next;
  }

  return nodes
    .map((symbol, i) => ({ symbol, score: rank[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
