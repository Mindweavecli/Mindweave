<h1 align="center">Mindweave</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent. You bring your own key; it does the work.
</p>

<p align="center">
  <a href="https://github.com/mindweave-cli/Mindweave/blob/main/LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="https://github.com/mindweave-cli/Mindweave/stargazers">Stars</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X (Twitter)</a>
</p>

---

## What is Mindweave?

Mindweave is a coding agent that lives in your terminal and works inside your repository: reading, searching, editing, running commands, and checking its own work. It runs **entirely on your machine**. Your code and your API key never touch a Mindweave server.

It is built lean on purpose. Most of a coding agent's context budget goes on scaffolding the model never needed. Mindweave keeps prompts thin and leaves the room for the model to actually reason about your code.

Bring your own key. Pick your model. It does the work.

How the project is run, what gets into the core, and what does not: [PHILOSOPHY.md](PHILOSOPHY.md). It is short, and it is the honest version.

## Coming up: Release 1

Mindweave has been built in the open through the 1.x line, and it is close to the real thing.

The next milestone is the **official release: Mindweave 1**. That is when it lands on npm, installable in one command, with the version numbering reset to match. Release 1 is the first version meant for people who were not watching it get built.

**The new UI is fully designed and lands before then.** It was drawn from scratch rather than borrowed, because a terminal is not a small browser and pretending otherwise is why so many CLI tools feel busy. It is quieter than what ships today, it gets out of the way while the agent works, and it tells you what is happening without asking you to watch. That is all we are saying for now.

Between here and there: no new features. Just real use, and fixing whatever that turns up.

## Features

- **Fully local & BYOK.** Bring your own model API key. No backend, no telemetry, no lock-in.
- **Model-adaptive drivers.** Each model family gets its own driver so it runs at its best without bloating the core. Only the driver you're using is ever loaded.
- **Deterministic code intelligence.** A background lane indexes your repo with tree-sitter and language servers (no tokens, no cost) so the agent understands your codebase, not just the open file.
- **Real tools.** File read/edit, multi-file edits, ripgrep search, shell with background jobs, sub-agents, and diagnostics, with read-before-edit safety and an undo net.
- **Session memory.** Long sessions stay sharp: automatic compaction plus a continuously-maintained state summary that survives it. The agent can also read its own earlier sessions in a project, so "what did we do last time" gets a real answer.
- **MCP servers.** Connect external tool servers (GitHub, Postgres, your own) with `/mcp add` or just by asking. They start with your session, and their tools are treated as untrusted by default.
- **Images.** Drag a screenshot into the prompt, or write `@shot.png`, and a model that can see gets the image itself. On a text-only model it says so plainly instead of pretending.
- **Per-project governor.** Give a project standing rules, reusable skills, and forbidden paths/commands that the agent must respect.
- **Interaction modes.** Lightning (auto), Architect (plan-only, read-only), cycled with `shift-tab`.

## Requirements

- **Node.js 20+**
- A model API key (see below)
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for faster search. Mindweave falls back to a built-in walker if it's not installed.

> **Platforms:** Mindweave is developed and tested primarily on **Windows**. It's built on cross-platform Node and should run on macOS and Linux. If you hit a platform issue there, please open an issue.

## Install

Mindweave installs from source:

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

On first launch, Mindweave asks for your API key and saves it to `~/.mindweave/.env` so it works in every project. Then just type what you want done.

### Your key

Mindweave is **bring-your-own-key**. Two providers ship today:

```
DEEPSEEK_API_KEY=your-key-here     # deepseek-v4-flash, deepseek-v4-pro
ANTHROPIC_API_KEY=your-key-here    # claude-sonnet-5, claude-opus-5
```

You only need the key for the provider whose models you use. Set both and you can switch between them with `/provider` in the same project. Set a key during the first-run prompt, in `~/.mindweave/.env`, or as an environment variable.

## Choosing a provider and model

- `/provider` picks who serves the project, and shows which providers you have a key for.
- `/model` picks which of that provider's models answers.
- `/think` picks how hard it reasons.
- `/help` lists every command.

Your choice is remembered per project. See [`src/drivers/PROVIDERS.md`](src/drivers/PROVIDERS.md) for the current model list, and [`src/drivers/README.md`](src/drivers/README.md) if you want to build a driver for another model.

## Connecting MCP servers

[MCP](https://modelcontextprotocol.io) servers give the agent tools Mindweave does not ship: issue trackers, databases, cloud APIs, internal services.

```bash
/mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=ghp_x
```

Or just ask for it in plain words and the agent writes the config. Full guide, including remote servers and how a changed tool description is handled: [docs/MCP.md](docs/MCP.md).

## Roadmap

Shipped through the 1.x line: the Anthropic driver alongside DeepSeek, providers loaded on demand, sessions the agent can read back, MCP with rug-pull protection, rebuilt editing tools, per-model compaction, background jobs that report when they are up, undo that will not overwrite your own work, and images you can attach and have looked at.

- [x] **v1.9: core hardening.** Every subsystem the agent actually runs, read fresh one at a time rather than trusted because it shipped. Feature freeze starts here.
- [ ] **Release 1.** The new UI, npm, and the numbering reset.
- [ ] More model drivers (OpenAI, Qwen, Ollama, and others), community-built.
- [ ] Verified macOS and Linux support, community-owned.
- [ ] OAuth for remote MCP servers.

## Found a bug?

**Please open an issue.** Mindweave is developed by running it on real projects and fixing what breaks, so a reproduction from someone else's setup is genuinely the most useful thing you can send. Nearly every item in the release notes above started as a failure someone watched happen.

Useful to include: your OS and terminal, which model you were on, and the steps that led to it. If the agent did something odd rather than crashed, the transcript around it helps more than a description does.

Especially worth reporting:
- **Anything MCP.** It's still young, and only one real published server has been driven end to end; resources and prompts have only been tested against servers we wrote. Real servers will find edges we didn't.
- **A tool the agent was offered but couldn't call**, or one it insisted didn't exist.
- **Anything on macOS or Linux.** Development happens on Windows; those two are believed to work but aren't verified.
- **A prompt or menu that says something untrue.** Those can't crash and don't fail tests, so they survive until a person notices.

## Contributing

Mindweave is open source and contributions are welcome, especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

Small fixes and reproduced bugs with a failing test can go straight to a pull request. For anything larger, start a Discussion first. [PHILOSOPHY.md](PHILOSOPHY.md) explains where the two bars sit and what evidence moves the core one, and the guide covers the mechanics.

## License

[Apache License 2.0](LICENSE).
