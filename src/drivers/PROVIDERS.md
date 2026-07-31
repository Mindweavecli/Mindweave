# Choosing your model

Mindweave is **bring-your-own-key (BYOK)**: you pick a model, you use your own API
key for it, and everything runs on your machine. Nothing is sent to a Mindweave
server.

Each model has a **driver** that tunes Mindweave to run that model at its best. Only
the driver for the model you're using is ever active — so your setup stays fast and
lean no matter how many providers exist.

## Available now

| Provider | Models | Key | Notes |
| --- | --- | --- | --- |
| **DeepSeek** | `deepseek-v4-flash`, `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | The default. Flash is fast and cheap; Pro is stronger for harder work. |
| **Anthropic** | `claude-sonnet-5`, `claude-opus-5` | `ANTHROPIC_API_KEY` | Sonnet 5 is fast and strong at code; Opus 5 is the most capable. Four reasoning levels each. |

More providers (OpenAI, Qwen, Ollama, …) are on the way — each added as a
community-built driver. See the roadmap in the repo.

## Picking a model

- `/model` — choose which model answers.
- `/think` — choose how hard it reasons (higher = deeper, slower, costs more).

Your choice is remembered per project.

## Setting your key

Set the provider's key as an environment variable, or put it in your config `.env`
so it works in every project:

```
DEEPSEEK_API_KEY=your-key-here
ANTHROPIC_API_KEY=your-key-here
```

You only need a key for the provider whose models you actually use. Set both and
you can switch between them with `/model` in the same project. Keys stay on your
machine — they're never uploaded anywhere.
