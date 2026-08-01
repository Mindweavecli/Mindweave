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

## v1.3 is out: MCP

MindWeave speaks the **Model Context Protocol**, so external tool servers — GitHub, Postgres, your company's internal API — become tools the agent can use directly.

**You don't start anything.** Add a server once and MindWeave spawns and manages it for you, every session, in the background:

```
/mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=ghp_x
/mcp add --http internal https://tools.acme.dev/mcp
```

Or just say it — "add the github mcp server, my token's in GITHUB_TOKEN" — and the agent writes the config after asking you to confirm. Either way the server connects immediately and its tools are usable in the same turn. `/mcp` shows what's running, which protocol each server negotiated, and reconnects anything that's down.

**It targets the current protocol, not last year's.** The 2026-07-28 revision made MCP stateless: no handshake, no session id, no SSE resumability, and a new `server/discover` call. Almost every server in the wild still speaks an older revision, so MindWeave probes and speaks whichever one a server actually knows. Both stdio and Streamable HTTP work. A server that crashes is revived automatically, up to a point, and then says so rather than retrying forever.

**A big catalog doesn't drown the model.** Past 25 tools, servers' tools are held back and the agent searches for what it needs instead. This is about accuracy before cost: a model choosing among 300 tools chooses worse than one choosing among 40, however much context is free.

**Server tool descriptions are treated as untrusted, because they are.** A description goes straight into the model's prompt and is read as instruction, which makes it an injection surface. MindWeave fingerprints every tool's description and schema, and if one changes it blocks the tool and asks you before letting it run again — that's the "rug pull" attack, where a server you trust ships a poisoned update. Server output is delimited as data rather than instruction, and `forbid_mcp_tool` bans a single tool without disabling its server. What this does *not* do is verify a server is safe to begin with; [SECURITY.md](SECURITY.md) is explicit about that.

**Also in this release.** DeepSeek's usable context window was set far too conservatively (128K against a real 1M) and ignored which model you were on, so long sessions compacted much earlier than they needed to. V4-Pro now runs to 256K and V4-Flash to 192K, anchored to where multi-needle retrieval actually holds up rather than to a round number. Short sessions now write notes too, so asking about a brief one no longer falls back to re-reading its whole transcript.

**Next up:** MCP resources and prompts, then OAuth for remote servers that need it.

## Features

- **Fully local & BYOK.** Bring your own model API key. No backend, no telemetry, no lock-in.
- **Model-adaptive drivers.** Each model family gets its own driver so it runs at its best — without bloating the core. Only the driver you're using is ever loaded.
- **Deterministic code intelligence.** A background lane indexes your repo with tree-sitter and language servers (no tokens, no cost) so the agent understands your codebase, not just the open file.
- **Real tools.** File read/edit, multi-file edits, ripgrep search, shell with background jobs, sub-agents, and diagnostics — with read-before-edit safety and an undo net.
- **Session memory.** Long sessions stay sharp: automatic compaction plus a continuously-maintained state summary that survives it. The agent can also read its own earlier sessions in a project, so "what did we do last time" gets a real answer.
- **MCP servers.** Connect external tool servers (GitHub, Postgres, your own) with `/mcp add` or just by asking. They start with your session, and their tools are treated as untrusted by default.
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

**Two things worth knowing.** If a server's tool description changes between sessions, that tool is blocked until you approve it — a changed description is the main way a trusted server turns hostile. And remote servers requiring OAuth aren't supported yet; they'll show as `needs-auth`.

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
- [x] **v1.2: reads its own past sessions, failure loops interrupt instead of stopping dead, every early stop explains itself**
- [x] **v1.3: MCP / external tool servers, with rug-pull protection and a deferred tool pool**
- [ ] **v1.4: MCP resources & prompts, OAuth for remote servers** — the next release
- [ ] More model drivers (OpenAI, Qwen, Ollama, …) — community-built
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

MindWeave is open source and contributions are welcome — especially **model drivers**. See the [Contributing Guide](CONTRIBUTING.md), and open an issue or a Discussion to claim a provider.

Small fixes and reproduced bugs with a failing test can go straight to a pull request. For anything larger, start a Discussion first: the core is deliberately close to finished, and the guide explains what that means for scope before you spend an afternoon on it.

## License

[Apache License 2.0](LICENSE).
