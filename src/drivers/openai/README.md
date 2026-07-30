# OpenAI driver (unclaimed)

Driver for OpenAI models (GPT and o-series).

**Unclaimed** — open an issue to claim it. See `../README.md` for the contract and
workflow.

## Notes for the Driver Lead

- **OpenAI-native**, so the DeepSeek reference is a close starting point — same
  `chat/completions` + `tool_calls` + SSE shape.
- **Reasoning:** map `/think` onto the `reasoning_effort` control for o-series
  models.
- **Caching:** automatic prefix caching, same as DeepSeek — keep the prefix stable.
- **Key:** `OPENAI_API_KEY`.
