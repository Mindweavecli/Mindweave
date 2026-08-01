# Security Policy

## Supported versions

MindWeave ships from `main`. Security fixes land there and go out in the next release; there are no maintained older branches yet.

| Version | Supported |
| ------- | --------- |
| `main` / latest release | Yes |
| Anything older | No |

---

## The threat model, honestly

MindWeave is a local, single-user tool. It runs on your machine, with your API key, inside your repository, and it edits files and runs shell commands on your behalf. That is the product, and it means the interesting risks are not the ones a web app has:

- **There is no MindWeave server.** No backend, no telemetry, no account. Your code and your key go to your model provider and nowhere else.
- **The agent has real capability.** It writes files and executes commands. A model that makes a bad call can do damage, the same way you can.
- **The model is not trusted input.** A model can be wrong, and a repository can contain text written to manipulate one. Anything that must hold has to be enforced mechanically, not asked for in a prompt.

That last point is the design rule for everything below. A sentence in the system prompt is a request. A check in the tool layer is a wall.

## What is enforced mechanically

These live in `src/tools/guard.ts` and the governor, and none of them depend on the model cooperating.

- **Secrets are never readable.** `.env`, `.ssh`, `*.pem`, private keys, and `.git` internals are refused by the file tools, excluded from search results, and blocked from shell commands that would print them. All three paths are gated, not just the obvious one, because `grep -r` and `cat` walk straight around a per-file check.
- **A short list of catastrophic commands is refused.** Wiping a filesystem root, reformatting a disk, writing to a raw device, fork bombs. Deliberately narrow and high-confidence. This is a seatbelt, not a sandbox.
- **Another tool's private data is asked about first.** If a project has been worked on by a different coding agent, its saved conversations and rules are not ours to read. MindWeave asks you before touching them rather than helping itself, and search skips them outright.
- **Per-project forbidden paths and commands.** `/forbidden <path>` makes a path untouchable and the tools refuse it. Only you can lift it, per session, through an approval prompt. The model cannot lift it or work around it.
- **Plan mode changes nothing.** In Architect mode the mutating tools are withheld from the request entirely, and refused if called anyway.
- **Sentinel mode asks before every mutating action**, at the single execution choke point, so it covers every tool including sub-agent edits. It fails closed: no approval channel, or an unclear answer, refuses.

What this is **not**: a sandbox, a jail, or a defense against a model deliberately trying to evade a string check. A single-user local tool does not ship a shell analyzer, and pretending otherwise would be worse than saying so. If you need true isolation, run MindWeave in a container or a VM.

## Your key

MindWeave is bring-your-own-key. Keys are read from `~/.mindweave/.env`, a project `.env`, or your shell environment, and that file is written with `0600` permissions. Keys are never logged, never printed into the transcript, and never sent anywhere except the provider they belong to. Nothing about a key crosses a driver boundary: each provider's driver only ever sees its own.

---

## Reporting a vulnerability

**Do not open a public issue or discussion for a security problem.**

1. **Preferred:** the repository's **Security** tab, then **Report a vulnerability** (GitHub private vulnerability reporting).
2. If that is unavailable, contact the maintainer privately.

### What to include

- What the vulnerability is, and what an attacker gets out of it.
- Steps to reproduce, ideally a minimal example.
- OS, terminal, and which model provider or driver was involved.
- Relevant logs, with keys, tokens, and personal paths redacted.

### Especially worth reporting

- Any way to get a secret's contents into the transcript, since that means it reaches the provider and the saved session file.
- A mutating action that runs without approval in Sentinel mode, or at all in Plan mode.
- A forbidden path or command that a tool touches anyway.
- A driver reading, logging, or transmitting anything belonging to a different provider.
- Prompt injection from repository content that causes a real action rather than just odd output. Odd output is a model problem; a file being written is ours.

### Response

- Acknowledgement within 48 hours.
- Updates as the fix progresses, and credit in the release notes unless you would rather not be named.

---

## For contributors

- Never commit a key, token, or `.env`. Sanitize logs in issues and pull requests.
- If you add a tool that reads files or runs commands, route it through the existing guards. A new path to file contents that skips `guard.ts` is a vulnerability even if nothing has exploited it yet, and that has happened here before.
- Enforce in the tool layer, not the prompt. See [BOUNDARY.md](BOUNDARY.md).
