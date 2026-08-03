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

MindWeave is a coding agent that lives in your terminal and works directly inside your repository, reading, searching, editing, running commands, and verifying its own work. It runs **entirely on your machine**: your code and your API key never touch a MindWeave server.

It's built lean on purpose. Instead of burning your context budget on heavy scaffolding, MindWeave keeps prompts thin and leaves the model room to actually reason about your code.

## The philosophy: a core that stays still

This section is permanent. It is the clearest statement of how this project is run, and it is here so nobody has to guess before they open an issue or write a line of code.

**MindWeave is open to everyone for suggestions. The core is not open to everything.**

Anyone can propose anything. Issues, discussions, pull requests, all welcome, and a good idea from a first-time contributor carries exactly as much weight as one from a maintainer. What differs is where the idea lands, because this project has two very different bars.

**Drivers are wide open.** Everything that makes one model family run at its best belongs in `/drivers/<provider>`: wire format, request shape, cache breakpoints, prices, context windows, parsing repairs. Models ship faster than anything else in this field, and the driver layer is designed to absorb that churn without the middle of the agent moving at all. If you want to change something, this is almost always where it should go, and the answer here is usually yes.

**The core is deliberately near-finished, and the bar to change it is high on purpose.** The agent loop, the tools, their safety gates, the system prompt, memory, and compaction are the parts every provider and every user depends on. They change when there is a reproduced bug, a demonstrated correctness gap, or a genuinely better architecture that has been measured against the current one. They do not change because something is fashionable, because another tool shipped it, or because it might be useful to somebody.

This is the same shape that has kept other long-lived systems alive. The Linux kernel holds a hard line against breaking userspace, and has for decades, while drivers underneath churn constantly. The stability is not stagnation. It is what makes everything built on top of it safe to rely on. A tool that rewrites its foundations every time the field moves is a tool nobody can build a habit around.

### What gets added

One test, and it is not about whether an idea is clever:

> Does this make the developer spend less, get better results, and work faster and more smoothly?

If it does not clearly do at least one of those, with the others not made worse, the answer is no. That is not a lack of ambition. Every capability in the core is paid for by every user on every turn, forever, and most of the cost is invisible at the moment it is added.

### Replacing beats adding

**We are looking to replace, not to accumulate.** Every tool has a real price: its description and schema are sent to the model on every uncached turn, so a tool nobody uses still costs tokens on every request from everyone. It also costs something worse than tokens. A model choosing among a large set of tools chooses worse than one choosing among a small set, whatever the context window allows, so each addition slightly degrades every decision the agent makes about the tools that were already there.

So the preferred shape of a good contribution is: this replaces that, and here is why the result is smaller, faster, or more correct. A proposal that adds a capability and removes nothing has to justify its permanent cost to everyone, not just its benefit to the person proposing it.

### Got some core idea?

Bring evidence, not preference. A better architecture is genuinely welcome and will be taken seriously, on these terms:

- Show what is slow, wrong, or clumsy about the current design, with something reproducible.
- Show that the alternative is actually better, measured against what exists now rather than against an idea of it.
- Show what it costs: tokens, complexity, surface area, and what it means for every provider rather than the one you use.

If the numbers say the current architecture is worse, it changes. That has already happened more than once in this project, and each time it was because someone measured rather than argued. What will not move it is "most tools do it this way" or "it would be nice to have".

Open a Discussion before writing code for anything core-shaped. We will talk it through, and where it makes sense we will test it properly and let the result decide. Being told no early is a better outcome than spending an afternoon on something that was never going to be merged, and this is written down precisely so that conversation can start honestly.

## v1.5: it leaves your machine the way it found it

Every item here started as something watched happening on a real project. The theme is the agent no longer fighting you over processes it started, or leaving them behind when it's done.

### Processes

**Close your app and it stays closed.** Starting a dev server and then closing it yourself made the agent open it again, and again. It had been told the app "failed", because the check for a deliberate stop only recognised a clean exit code of zero. Measured, that is not what closing something looks like: on Windows a closed app reports exit code 1, and Ctrl+C or a kill report no code at all. Three of the four ways an app can end were reading as a crash. It now asks what actually happened instead of reading a number that means different things on different platforms, and uses how long the thing had been running to tell "you closed it" apart from "it never came up", which are otherwise indistinguishable.

**Esc cancels what hasn't run yet.** Interrupting a turn stopped the tool that was running but not the ones queued behind it, so a command the model had already committed to still went ahead after you pressed Esc. In the worst case that was a background process, which by design outlives the turn, so you were left with something running that you believed you had cancelled.

**Nothing is left running when you quit.** Language servers, MCP servers and background shells were all supposed to be killed on exit. On Windows they were not: the kill was asynchronous, and Node runs no asynchronous work while it is shutting down, so the request never reached the operating system at all. Servers started through a shell were separately losing only their wrapper while the real process kept going. Both are fixed, and language servers now get the protocol's proper shutdown handshake rather than having their pipe cut from under them.

**Language servers stop growing all session.** Every symbol lookup opened another fifty files into the server and never closed one, so a long session gradually fed it an entire repository. There is now a ceiling on how much stays open.

### Context

**Compaction is anchored to each model, from numbers the driver measured.** The point at which a session gets summarized used to come from fixed constants in the core, including a guess at how much room a summary needs. That figure now comes from the driver that knows it. The bar for clearing old tool output also gained an absolute ceiling, because a flat share of the window stops meaning "small" once windows get large: on a 500K model it would have carried 150K of stale output on every single turn, which on your own API key is your money.

**Next up:** OAuth, for remote servers that need a login.


## Features

- **Fully local & BYOK.** Bring your own model API key. No backend, no telemetry, no lock-in.
- **Model-adaptive drivers.** Each model family gets its own driver so it runs at its best without bloating the core. Only the driver you're using is ever loaded.
- **Deterministic code intelligence.** A background lane indexes your repo with tree-sitter and language servers (no tokens, no cost) so the agent understands your codebase, not just the open file.
- **Real tools.** File read/edit, multi-file edits, ripgrep search, shell with background jobs, sub-agents, and diagnostics, with read-before-edit safety and an undo net.
- **Session memory.** Long sessions stay sharp: automatic compaction plus a continuously-maintained state summary that survives it. The agent can also read its own earlier sessions in a project, so "what did we do last time" gets a real answer.
- **MCP servers.** Connect external tool servers (GitHub, Postgres, your own) with `/mcp add` or just by asking. They start with your session, and their tools are treated as untrusted by default.
- **Per-project governor.** Give a project standing rules, reusable skills, and forbidden paths/commands that the agent must respect.
- **Interaction modes.** Lightning (auto), Architect (plan-only, read-only), cycled with `shift-tab`.

## Requirements

- **Node.js 20+**
- A model API key (see below)
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for faster search. MindWeave falls back to a built-in walker if it's not installed.

> **Platforms:** MindWeave is developed and tested primarily on **Windows**. It's built on cross-platform Node and should run on macOS and Linux. If you hit a platform issue there, please open an issue.

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

- `/model` picks which model answers.
- `/think` picks how hard it reasons.

Your choice is remembered per project. See [`src/drivers/PROVIDERS.md`](src/drivers/PROVIDERS.md) for the current model list, and [`src/drivers/README.md`](src/drivers/README.md) if you want to build a driver for another model.

## Connecting MCP servers

[MCP](https://modelcontextprotocol.io) servers give the agent tools MindWeave doesn't ship: issue trackers, databases, cloud APIs, internal services. Add one and it's available from that moment on, in every future session, with nothing to start by hand.

```bash
# a local server
/mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=ghp_x

# a remote one
/mcp add --http internal https://tools.acme.dev/mcp --header 'Authorization: Bearer t'

# available in every project, not just this one
/mcp add --global notes npx -y some-notes-server

# a server with its own flags: everything after -- goes to the server
/mcp add mine my-server -- --port 9000 --verbose

/mcp             # what's running, and reconnect anything that isn't
/mcp remove x    # stop configuring it
```

You can also just ask: *"add the github mcp server, my token's in GITHUB_TOKEN."* The agent writes the config and asks you to confirm before anything is saved.

Servers are declared in `.mindweave/mcp.json` (this project) or `~/.mindweave/mcp.json` (everywhere), in the same format every other MCP client uses, so an existing config can be pasted straight in.

**Two things worth knowing.** If a server's tool description changes between sessions, that tool is blocked until you approve it, because a changed description is the main way a trusted server turns hostile. And remote servers requiring OAuth aren't supported yet; they'll show as `needs-auth`.

## Roadmap

- [x] **v1.0: first public release**
- [x] **v1.1: Anthropic (Claude) driver, providers loaded on demand, provider-aware setup, cut off replies caught**
- [x] **v1.1.2: shared core made provider-neutral, with tests guarding it**
- [x] **v1.2: reads its own past sessions, failure loops interrupt instead of stopping dead, every early stop explains itself**
- [x] **v1.3: MCP / external tool servers, with rug-pull protection and a deferred tool pool**
- [x] **v1.4: MCP hardening with resources and server prompts, and rebuilt editing tools**
- [x] **v1.5: processes cleaned up properly, an Esc that actually cancels, per-model compaction**
- [ ] **v1.6: OAuth for remote servers**, the next release
- [ ] More model drivers (OpenAI, Qwen, Ollama, …), community-built
- [ ] Verified macOS / Linux support

## Found a bug?

**Please open an issue.** MindWeave is developed by running it on real projects and fixing what breaks, so a reproduction from someone else's setup is genuinely the most useful thing you can send. Nearly every item in the release notes above started as a failure someone watched happen.

Useful to include: your OS and terminal, which model you were on, and the steps that led to it. If the agent did something odd rather than crashed, the transcript around it helps more than a description does.

Especially worth reporting:
- **Anything MCP.** It's still young, and only one real published server has been driven end to end; resources and prompts have only been tested against servers we wrote. Real servers will find edges we didn't.
- **A tool the agent was offered but couldn't call**, or one it insisted didn't exist.
- **Anything on macOS or Linux.** Development happens on Windows; those two are believed to work but aren't verified.
- **A prompt or menu that says something untrue.** Those can't crash and don't fail tests, so they survive until a person notices.

## Contributing

MindWeave is open source and contributions are welcome, especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

Small fixes and reproduced bugs with a failing test can go straight to a pull request. For anything larger, start a Discussion first. [The philosophy section above](#the-philosophy-a-core-that-stays-still) explains where the two bars sit and what evidence moves the core one, and the guide covers the mechanics.

## License

[Apache License 2.0](LICENSE).
