# Ollama driver (unclaimed)

Driver for **local** open-weight models run through Ollama — no cloud, no key, no
per-token cost. Fits Mindweave's fully-local story well.

**Unclaimed** — open an issue to claim it. See `../README.md` for the contract and
workflow.

## Notes for the Driver Lead

- **OpenAI-compatible** local endpoint (default `http://localhost:11434`), so the
  DeepSeek reference is a good starting point.
- **No key**, and **no prompt caching** — set pricing to zero and keep the request
  small, since local models have tighter context and weaker tool-calling. Extra
  parsing fixes likely live here.
- **Model list is dynamic** (whatever the user has pulled locally) — the `models`
  list may need to be discovered at runtime rather than hard-coded.
