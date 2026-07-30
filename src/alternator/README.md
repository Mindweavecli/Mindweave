# alternator/ — the always-on code-intelligence lane

The `alternator` runs off the engine continuously and powers the rest at **no
token cost**: it builds and maintains the **`chassis`** — a structural map of the
project (symbols, where they're defined, who references them, what's relevant) —
so the model can ask the graph instead of re-reading or grepping blindly.

Like a car's alternator, it's deterministic plain code: **no AI calls, no
tokens.** It runs in the background, warms on session start, and reconciles
itself as files change.

## Layers (best-available-first, graceful degradation)

1. **LSP tier** (`chassis/lsp.ts` + `chassis/servers.ts`) — compiler-accurate
   defs/refs via auto-provisioned language servers. Tagged `resolved`.
2. **tree-sitter tier** (`chassis/treesitter.ts`) — universal, any language with a
   grammar; name-level defs/refs/outline. Tagged `name-level`.
3. **grep/read** stay the ground truth the chassis defers to. Every chassis answer
   carries a `Confidence`, and the model is told to verify with grep/read when it
   matters (the zero-importer caveat, encoded in the type).

Over the reference graph, personalized **PageRank** (`chassis/rank.ts`) ranks
symbols by centrality so "what's relevant here" is precise, not a dump.

## How the model uses it

- Read-only tools (`outline`, `definition`, `references`, `relevant`) query the
  chassis on demand — near-zero baseline tokens.
- A tiny, budgeted ranked map is injected as background context, refreshed as the
  working set changes.

## Freshness & cache

The lane **warm-starts from an on-disk cache** (`~/.mindweave/chassis/<project>/graph.json`)
so a large repo doesn't re-parse each session, then **reconciles** in the
background on an interval (`MINDWEAVE_CHASSIS_REFRESH_MS`, default 8s, 0 disables):
re-index files whose size/mtime changed, drop deleted ones, re-save the cache.
This is the deterministic, dependency-free freshness approach — no flaky
file-watcher. Language servers are killed on session replace
(`/continue`) and on process exit.

## Files

- `lane.ts` — the background lane: warm from cache → reconcile → periodic refresh; clean shutdown.
- `chassis/types.ts` — the typed graph contract (branded ids, unions, confidence).
- `chassis/graph.ts` — the in-memory graph + builders (pure).
- `chassis/rank.ts` — personalized PageRank (pure).
- `chassis/treesitter.ts` — universal extraction (tree-sitter, 37 languages).
- `chassis/servers.ts` — language-server registry (bundled TS server; extensible).
- `chassis/lsp.ts` — LSP client manager (on-demand precise def/refs).
- `chassis/cache.ts` — on-disk graph cache (warm start).
- `chassis/index.ts` — `CodeChassis`: build/refresh from a project + the query API.
