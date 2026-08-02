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

### How to change our mind

Bring evidence, not preference. A better architecture is genuinely welcome and will be taken seriously, on these terms:

- Show what is slow, wrong, or clumsy about the current design, with something reproducible.
- Show that the alternative is actually better, measured against what exists now rather than against an idea of it.
- Show what it costs: tokens, complexity, surface area, and what it means for every provider rather than the one you use.

If the numbers say the current architecture is worse, it changes. That has already happened more than once in this project, and each time it was because someone measured rather than argued. What will not move it is "most tools do it this way" or "it would be nice to have".

Open a Discussion before writing code for anything core-shaped. We will talk it through, and where it makes sense we will test it properly and let the result decide. Being told no early is a better outcome than spending an afternoon on something that was never going to be merged, and this is written down precisely so that conversation can start honestly.

## v1.4: sharper MCP, and editing that holds up

Two halves. MCP got everything running it for real turned up, plus the parts of the protocol v1.3 didn't cover. And the editing tools, the ones every task leans on, were rebuilt around what actually goes wrong.

### Editing

**Your indentation no longer has to be perfect.** An edit used to need a byte-exact match, so if the model retyped a block with the wrong leading whitespace, something it cannot see, the edit was refused and a turn went to waste. Matching is now exact first, then line-by-line ignoring each line's surrounding whitespace. It stops there on purpose: looser matching does not remove failures, it converts visible refusals into silent edits landing in the wrong place, which is a class of bug other tools are still carrying.

**When a change could go in two places, you get told where.** Before, an ambiguous edit produced "matches 2 places" and nothing else, so the retry was another guess. Now it comes back with each candidate, its line number, and enough surrounding code to tell them apart, widening the window until they actually read differently. Both ways out are always named: extend the match, or change all of them.

**Several changes to one file go in one call.** `multi_edit` applies them in order, each seeing the last one's result, and if any fails to match the file is left completely untouched rather than half-edited. One call per file, by design: a change you can review beats one you have to trust.

**Editing a file that moved under you is caught.** If a command, a formatter, or you changed a file after the agent read it, the edit is refused and says so. It used to report this as a typo, sending the model to retype a string that could never match. Worse, if the change was somewhere it wasn't editing, the edit went through against content nobody had looked at.

**Internal retries stay off your screen.** An agent adjusting its own aim is not an error you can act on, and a screen full of "could not edit because…" trains you to ignore the rows that matter. Real failures, permissions, missing files, failed writes, are as visible as ever.

### MCP

**Windows could not start most MCP servers.** `spawn` on Windows doesn't resolve a bare command name through PATHEXT, and the transport only used a shell when the command literally ended in `.cmd`. So `{"command": "npx", ...}`, which is how almost every MCP server on earth is configured, failed with `spawn npx ENOENT`. It now resolves properly, and a server that gets shut down has its whole process tree killed instead of just the shell wrapping it, so nothing is left running after you quit.

**The rug pull check only ran at startup.** Tool descriptions were fingerprinted when a server connected, and never again. A server could therefore connect clean, pass the check, then announce a changed tool list and have new descriptions loaded straight into the model's prompt unexamined. That is the exact attack the check exists to stop. Every catalog change is now verified, and anything that moved is blocked with a notice until you review it in `/mcp`.

**One server could swallow a whole turn.** There was no ceiling on the size of a tool result, so a server answering with a large payload put all of it in the model's context, and an image went in as base64 nobody can read. Oversized and binary results are now saved to a file, and the model gets the first part plus the path, so nothing is lost and the turn survives.

**Resources.** Servers expose data as well as actions: a database schema, a runbook, a log. The agent can now list and read those, including URI templates it fills in itself. They are fetched only when it goes looking, and they never enter the tool list, so a server with a thousand resources costs nothing until it is used.

**Prompts as slash commands.** A server can ship its own commands, and they appear alongside your project's skills. Type `/github:review 4821 focus on the migration` and the server writes the instructions.

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
- [ ] **v1.5: OAuth for remote servers**, the next release
- [ ] More model drivers (OpenAI, Qwen, Ollama, …), community-built
- [ ] Verified macOS / Linux support

## Found a bug?

**Please open an issue.** MindWeave is developed by running it on real projects and fixing what breaks, so a reproduction from someone else's setup is genuinely the most useful thing you can send. Nearly every item in the release notes above started as a failure someone watched happen.

Useful to include: your OS and terminal, which model you were on, and the steps that led to it. If the agent did something odd rather than crashed, the transcript around it helps more than a description does.

Especially worth reporting:
- **Anything MCP.** It's new in v1.3, and it has only been tested against servers we wrote. Real servers will find edges we didn't.
- **A tool the agent was offered but couldn't call**, or one it insisted didn't exist.
- **Anything on macOS or Linux.** Development happens on Windows; those two are believed to work but aren't verified.
- **A prompt or menu that says something untrue.** Those can't crash and don't fail tests, so they survive until a person notices.

## Contributing

MindWeave is open source and contributions are welcome, especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

Small fixes and reproduced bugs with a failing test can go straight to a pull request. For anything larger, start a Discussion first. [The philosophy section above](#the-philosophy-a-core-that-stays-still) explains where the two bars sit and what evidence moves the core one, and the guide covers the mechanics.

## License

[Apache License 2.0](LICENSE).
