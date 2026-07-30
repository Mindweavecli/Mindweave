# Anthropic driver (unclaimed)

Driver for Claude models (Opus, Sonnet, Haiku).

**Unclaimed** — open an issue to claim it. See `../README.md` for the contract and
workflow.

## Notes for the Driver Lead

- **Not OpenAI-compatible.** Uses the Anthropic **Messages API** with content blocks
  and native tool use — the request rendering differs most from the DeepSeek
  reference here.
- **Caching is explicit:** insert `cache_control` breakpoints at the prefix boundary
  (after tools / system / the last stable message). `ModelRequest` already marks
  where the stable prefix ends.
- **Reasoning:** map `/think` levels onto extended thinking (thinking budget).
- **Key:** `ANTHROPIC_API_KEY`.
