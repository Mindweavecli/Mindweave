<h1 align="center">MindWeave</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent. You bring your own key; it does the work.
</p>

<p align="center">
  <a href="https://github.com/mindweave-cli/Mindweave/blob/main/LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="https://github.com/mindweave-cli/Mindweave/stargazers">Stars</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X (Twitter)</a>
</p>

---

## What is MindWeave?

MindWeave is a coding agent that lives in your terminal and works directly inside your repository — reading, searching, editing, running commands, and verifying its own work. It runs **entirely on your machine**: your code and your API key never touch a MindWeave server.

It's built lean on purpose. Instead of burning your context budget on heavy scaffolding, MindWeave keeps prompts thin and leaves the model room to actually reason about your code.

## v1.1 is out

Claude joins DeepSeek as a second supported provider, and the driver system that makes that possible is now real rather than planned:

- **Anthropic (Claude) support.** Run `claude-sonnet-5` or `claude-opus-5` right alongside DeepSeek, switching anytime with `/model`.
- **Providers load on demand.** Only the driver for the model you picked ever loads. A DeepSeek user never pays the cost of Anthropic's SDK, and that stays true as more providers are added.
- **Setup asks for the right key.** First launch, or switching to a provider you have not used yet, prompts for that provider's key specifically instead of assuming you're on DeepSeek.
- **Cut off replies are caught, not hidden.** If a model hits its output limit or a provider declines a request, MindWeave now tells you plainly instead of quietly treating a half finished answer as complete.

**v1.1.1:** a dependency used only to unpack downloaded tooling had a known memory issue in old versions. It never affected anyone running MindWeave, and nothing was broken, but it's patched now so a fresh install won't flag it either.

## v1.1.2, and what we're working on now

Adding a second provider turned up something worth being open about: parts of MindWeave had quietly been written for one model rather than for all of them.

The system prompt is shared by every provider, byte for byte, so anything written to correct one model's habits gets paid for by all of them. That was fine when there was only one provider, because "universal" and "that provider" meant the same thing. It stopped being fine the moment Claude landed. Two instructions turned out to be aimed at a single model, and one of them provably wasn't even working on the model it was written for, while still costing everyone else tokens and attention. Both are gone.

The `/model` menu had the same problem in a more visible way. Its help text still read "DeepSeek V4 Flash / Pro" long after there were four models across two providers. It type-checked, every test passed, and it could never crash. It was just wrong, and sat in front of users every session.

Neither of those could fail loudly, which is the interesting part. So there are now two guards in the test suite: one asserting the removed prompt lines stay removed, and one that scans the whole shared core for hardcoded model names. [`BOUNDARY.md`](BOUNDARY.md) writes down the rule they enforce, and every trap listed in it is one we actually hit rather than one we imagined.

**This is ongoing.** We're still going through the codebase looking for places where one provider's assumptions leaked into shared ground. Expect more of these, and expect them to be written up plainly rather than folded into a changelog line. If you spot one, an issue is genuinely useful.

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
git clone https://github.com/mindweave-cli/Mindweave
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

MindWeave is **bring-your-own-key**. Two providers ship today:

```
DEEPSEEK_API_KEY=your-key-here     # deepseek-v4-flash, deepseek-v4-pro
ANTHROPIC_API_KEY=your-key-here    # claude-sonnet-5, claude-opus-5
```

You only need the key for the provider whose models you use. Set both and you can switch between them with `/model` in the same project. Set a key during the first-run prompt, in `~/.mindweave/.env`, or as an environment variable.

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
- [x] **v1.1: Anthropic (Claude) driver, providers loaded on demand, provider-aware setup, cut off replies caught**
- [x] **v1.1.2: shared core made provider-neutral, with tests guarding it**
- [ ] More model drivers (OpenAI, Qwen, Ollama, …) — community-built
- [ ] External tool-server support
- [ ] Verified macOS / Linux support

## Contributing

MindWeave is open source and contributions are welcome — especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

## License

[Apache License 2.0](LICENSE).
