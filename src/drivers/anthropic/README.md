# Anthropic driver

Driver for Claude models, built on the official `@anthropic-ai/sdk`.

**Key:** `ANTHROPIC_API_KEY`

## What ships

| Model | Notes |
| --- | --- |
| `claude-sonnet-5` | The default here. Fast, strong at code. |
| `claude-opus-5` | Most capable, for the hardest work. |

Four reasoning levels on both (Standard, Thinking, Deep, Maximum), which map to
adaptive thinking plus an `effort` budget.

Haiku 4.5 is deliberately **not** offered. It predates this request surface and
would need a second, legacy path (fixed thinking budgets, no `effort`), which is
complexity the driver doesn't need to carry to be useful. Adding it later means one
row in `manifest.ts` plus that alternate path in `client.ts`.

## Why this folder looks different from `deepseek/`

DeepSeek is OpenAI-compatible, so its client is close to a pass-through. Anthropic's
Messages API disagrees with the stored transcript in five places, and `client.ts`
exists to reconcile them:

1. `system` is a top-level request field, not the first message.
2. Assistant tool calls are `tool_use` **blocks**, and their arguments are a parsed
   object — the transcript stores them as a JSON string.
3. Tool results are `tool_result` blocks inside a **user** message; there is no
   `role: "tool"`.
4. All results from one assistant turn must arrive in a **single** user message.
   The transcript records them as consecutive `role: "tool"` entries, so runs are
   coalesced. Splitting them doesn't error — it quietly teaches the model to stop
   making parallel tool calls, which is why it's pinned by a test.
5. Caching is explicit. Two `cache_control` breakpoints are placed (last system
   block, last stable message), well under the limit of four, and the volatile
   `context` is appended after both so it never invalidates the prefix.

None of that changes *what* the model is asked to do. The system prompt is the same
bytes here as on any other provider — this driver controls format, not craft.

## Things the API rejects outright

Worth knowing before you change `buildBody`:

- `thinking: {type: "enabled", budget_tokens: N}` — removed. Use
  `{type: "adaptive"}` plus `output_config.effort`.
- `temperature`, `top_p`, `top_k` — removed on these models.
- On Opus 5, thinking may only be **disabled** at effort `high` or below. Pairing
  no-thinking with `xhigh` or `max` is a 400, so `normalize` steps it down first.
- Assistant-turn prefills — removed. Nothing here uses them.

A test asserts none of the removed parameters can appear in a request body.

## Testing

`client.test.ts` drives the conversion with hand-built transcripts: no network and
no API key. It covers parallel-result coalescing, argument round-tripping, cache
breakpoint placement, usage math (Anthropic's `input_tokens` is only the *uncached
remainder*, so the full prompt is that plus both cache figures), and the streaming
event mapping.
