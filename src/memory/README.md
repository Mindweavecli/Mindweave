# memory/ — session, persistence & context survival

Mindweave's sense of continuity: the conversation, where it's stored, and how it
stays coherent as a task grows. This is the **client** side of the eventual
client/server split — all disk I/O lives here; the engine (`dynamo`) stays pure
of the filesystem and just operates on the transcript it's handed.

## Shape

- `types.ts` — the transcript model. `Entry` is a discriminated union on `role`
  (`user | assistant | tool | summary`); switching on it is exhaustive, so the
  compiler — not a runtime hope — keeps us from building an impossible message
  (an orphan tool result, a tool-call with no calls). `Session` bundles the
  transcript, the tool context (live cwd + read ledger), and project memory.
- `store.ts` — persistence. Sessions live **outside the project**, under
  `~/.mindweave/projects/<sanitized-cwd>/`, as `<id>.jsonl`
  (transcript) + `<id>.meta.json` (descriptor for the resume picker). Best-effort:
  a failed write never breaks a turn.
- `session.ts` — `createSession()` (fresh) and `resumeSession()` (reload the
  latest saved session for this project). Loads `MINDWEAVE.md` into project memory.
- `compaction.ts` — the **pure** half of context survival (no I/O, no model
  calls): token estimation + the two transforms. The engine owns *when* and the
  summarizer call.

## Context survival (the cascade)

A long transcript dilutes the model's focus (and costs tokens every turn). Two
layers, cheapest first, run by the engine's `maybeCompact`:

1. **microcompact** (30% of the sharp window, lossless, no model call): clear the
   *bodies* of old tool results, keep the last `KEEP_LAST_N` verbatim and never the
   most recent round. A cleared result leaves a stub — the model can re-read.
2. **autocompact** (sharp window − 33K, one model call): replace the old prefix with
   a 9-section structured summary, keep the last N turns, then **re-read the
   working-set files** (restoration in the engine) so the model keeps the actual
   code, not just a description.

Both bars are **derived from the driver's sharp window** (`dynamo/contextWindow.ts`),
so they move with the model instead of being frozen in this module. On DeepSeek that
is 256K for V4-Pro and 192K for V4-Flash — where multi-needle retrieval still holds,
not the 1M storage cap. Env overrides remain
(`MINDWEAVE_MICROCOMPACT_TOKENS` / `MINDWEAVE_AUTOCOMPACT_TOKENS`).

Also reachable manually: `/compact` (force a summary now) and `/continue` (resume
the last session), handled in the CLI.

Tests: `memory.test.ts` (`npm test`).
