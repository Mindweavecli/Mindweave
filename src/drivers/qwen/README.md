# Qwen driver (unclaimed)

Driver for Qwen models (Alibaba / DashScope).

**Unclaimed** — open an issue to claim it. See `../README.md` for the contract and
workflow.

## Notes for the Driver Lead

- **OpenAI-compatible endpoint**, so this is one of the easiest to start from — the
  DeepSeek reference should mostly carry over.
- Confirm Qwen's tool-call reliability and add any model-specific parsing fixes in
  this folder if needed.
- **Key:** `DASHSCOPE_API_KEY` (or Qwen's OpenAI-compatible key).
