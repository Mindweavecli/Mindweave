# Choosing your model

Mindweave is **bring-your-own-key (BYOK)**: you pick a model, you use your own API
key for it, and everything runs on your machine. Nothing is sent to a Mindweave
server.

Each model has a **driver** that tunes Mindweave to run that model at its best. Only
the driver for the model you're using is ever active — so your setup stays fast and
lean no matter how many providers exist.

## Available now

| Provider | Models | Notes |
| --- | --- | --- |
| **DeepSeek** | `deepseek-v4-flash`, `deepseek-v4-pro` | The default. Flash is fast & cheap; Pro is stronger for harder work. |

More providers (Anthropic, OpenAI, Qwen, Ollama, …) are on the way — each added as a
community-built driver. See the roadmap in the repo.

## Picking a model

- `/model` — choose which model answers.
- `/think` — choose how hard it reasons (higher = deeper, slower, costs more).

Your choice is remembered per project.

## Setting your key

Set the provider's key as an environment variable, or put it in your config `.env`
so it works in every project. For DeepSeek:

```
DEEPSEEK_API_KEY=your-key-here
```

Each provider reads its own key (e.g. `DEEPSEEK_API_KEY`, later `ANTHROPIC_API_KEY`,
and so on). Keys stay on your machine — they're never uploaded anywhere.
