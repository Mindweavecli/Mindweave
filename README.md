<h1 align="center">MindWeave</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent. You bring your own key; it does the work.
</p>

<p align="center">
  <a href="https://github.com/Nimannns/Mindweave/blob/main/LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="https://github.com/Nimannns/Mindweave/stargazers">Stars</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X (Twitter)</a>
</p>

---

## What is MindWeave?

MindWeave is a coding agent that lives in your terminal and works directly inside your repository — reading, searching, editing, running commands, and verifying its own work. It runs **entirely on your machine**: your code and your API key never touch a MindWeave server.

It's built lean on purpose. Instead of burning your context budget on heavy scaffolding, MindWeave keeps prompts thin and leaves the model room to actually reason about your code.

## Features

- **Fully local & BYOK.** Bring your own model API key. No backend, no telemetry, no lock-in.
- **Model-adaptive drivers.** Each model family gets its own driver so it runs at its best — without bloating the core. Only the driver you're using is ever loaded.
- **Deterministic code intelligence.** A background lane indexes your repo with tree-sitter and language servers (no tokens, no cost) so the agent understands your codebase, not just the open file.
- **Real tools.** File read/edit, multi-file edits, ripgrep search, shell with background jobs, sub-agents, and diagnostics — with read-before-edit safety and an undo net.
- **Session memory.** Long sessions stay sharp: automatic compaction plus a continuously-maintained state summary that survives it.
- **Per-project governor.** Give a project standing rules, reusable skills, and forbidden paths/commands that the agent must respect.
- **Interaction modes.** Lightning (auto), Architect (plan-only, read-only), cycled with `shift-tab`.

## Requirements

- **Node.js 20+**
- A model API key (see below)
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for faster search — MindWeave falls back to a built-in walker if it's not installed.

> **Platforms:** MindWeave is developed and tested primarily on **Windows**. It's built on cross-platform Node and should run on macOS and Linux — if you hit a platform issue there, please open an issue.

## Install

MindWeave installs from source:

```bash
git clone https://github.com/Mindweavecli/Mindweave
cd Mindweave
npm install
npm run build
npm link          # makes the `mindweave` command available globally
```

## Quick start

```bash
cd your-project
mindweave
```

On first launch, MindWeave asks for your API key and saves it to `~/.mindweave/.env` so it works in every project. Then just type what you want done.

### Your key

MindWeave is **bring-your-own-key**. The first supported model is **DeepSeek**:

```
DEEPSEEK_API_KEY=your-key-here
```

Set it during the first-run prompt, in `~/.mindweave/.env`, or as an environment variable.

## Choosing a model

- `/model` — pick which model answers.
- `/think` — pick how hard it reasons.

Your choice is remembered per project. See [`src/drivers/PROVIDERS.md`](src/drivers/PROVIDERS.md) for the current model list, and [`src/drivers/README.md`](src/drivers/README.md) if you want to build a driver for another model.

## Roadmap

- [x] Terminal agent loop + streaming UI
- [x] File / shell / search tools, sub-agents, background jobs
- [x] Session memory + compaction
- [x] Deterministic code intelligence (tree-sitter + language servers)
- [x] Per-project governor (rules / skills / forbidden)
- [x] DeepSeek driver
- [x] **v1.0 — first public release**
- [ ] More model drivers (Anthropic, OpenAI, Qwen, Ollama, …) — community-built
- [ ] External tool-server support
- [ ] Verified macOS / Linux support

## Contributing

MindWeave is open source and contributions are welcome — especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

## License

[Apache License 2.0](LICENSE).
