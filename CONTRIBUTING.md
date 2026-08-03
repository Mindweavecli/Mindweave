# Contributing to MindWeave

First off, thank you for considering contributing to MindWeave!

MindWeave is built to be a fast, modular, terminal-native workspace for AI agents. Our core philosophy is to keep the orchestration engine vendor-neutral, while allowing specialized driver modules to deliver peak performance for every model provider.

Whether you're fixing a typo, adding a feature, or optimizing model performance under heavy context loads, your help makes this tool better for everyone.

---

## Project Goals & Architecture

* Terminal-First Experience: Blazing fast execution with zero unnecessary UI bloat.
* Modular Provider Drivers: Clean isolation between the core agent orchestrator and individual LLM API implementations (/drivers).
* Empirical Optimization: Tailoring prompt formats, tool-calling loops, and context caching per provider rather than using generic wrappers.

> **Read [BOUNDARY.md](BOUNDARY.md) before writing code.** It is one page and it
> answers the question every change in this repo has to answer first: does this
> belong in the shared core, or in one provider's driver? Getting that wrong is how
> a multi-provider agent slowly turns into a single-provider agent with extra steps.

---

## Call for Model Specialists & Domain Engineers

Are you working extensively with a specific model backend (e.g., DeepSeek, Qwen, Claude, OpenAI, Ollama, Grok, MiniMax, OpenRouter or any other open weight model)? Have you benchmarked context windows, fine-tuned prompt drivers, or solved tool-execution edge cases in production?

We are actively inviting engineers to step up as Driver Leads for specific model providers:

### What does a Driver Lead do?
* Direct Ownership: Get listed under CODEOWNERS for your designated provider directory (/drivers/<provider>).
* Architectural Influence: Shape how MindWeave handles prompt formatting, system instructions, token caching, and rate limiting for that specific model.
* Direct Feedback Loop: Help ensure your favorite API or local model delivers the absolute best user experience in a terminal environment.

If you have hands-on experience optimizing for a specific backend, open an issue or drop a comment in Discussions to claim or improve a driver!

### Who owns what right now

| Provider | Driver Lead | Status |
| --- | --- | --- |
| DeepSeek | [@Nimannns](https://github.com/Nimannns) (maintainer) | Taken |
| Anthropic (Claude) | Unclaimed | Shipped in v1.1, open to a lead |
| OpenAI | Unclaimed | Wanted |
| Qwen | Unclaimed | Wanted |
| Ollama / local models | Unclaimed | Wanted |
| Grok, MiniMax, OpenRouter, anything else | Unclaimed | Open |

**Everything except DeepSeek is free to claim.** DeepSeek is the reference driver and the maintainer keeps it, because a multi-provider architecture needs one driver that is definitively correct to measure the others against. Anthropic already exists and works; it still has no dedicated lead, so it is available to anyone who wants to own it properly.

To claim one, open an issue saying which provider and what you have actually run it against. Prior benchmarking or production experience with the backend matters far more than TypeScript polish; the wire code is the easy part.

### What a new driver actually involves

Less than people expect. A driver owns one provider's wire format, request shape, cache breakpoints, model list, prices, context window, and any parsing repairs that provider specifically needs. It does **not** own how the agent behaves. The system prompt is byte-identical whichever provider is selected, and that is not negotiable, because the moment a driver starts teaching the model how to work, every provider added afterwards makes the product worse instead of better.

Start with [`src/drivers/README.md`](src/drivers/README.md) for the contract and the manifest/driver split, and read [BOUNDARY.md](BOUNDARY.md) before you write anything. `registry.test.ts` enforces the boundary and is the test your driver has to keep passing.

---

## How to Contribute

### 1. Reporting Bugs
Before opening an issue, check the existing issues to avoid duplicates. When filing a bug report, please include:
* Your operating system and terminal environment.
* The model provider/driver you were using.
* Clear steps to reproduce the issue (along with sanitized logs, if applicable).

### 2. Proposing Features or Architectural Changes
* For minor tweaks or bug fixes: Feel free to submit a Pull Request directly.
* For major feature additions or core orchestrator changes: Please start a thread in GitHub Discussions first so we can align on the approach.

A word on scope, so nobody wastes an afternoon: **the core is deliberately close to finished.** The default answer to "should this be added" is no. What gets merged readily is a new driver, a reproduced bug with a failing test, or a demonstrated correctness gap. What does not is a feature nobody hit a wall without. A smaller core that does its job well beats a larger one that does more, and every line in the shared engine is paid for by every provider forever.

That is the short version. The full statement of how this project is run, why the core bar is high while the driver bar is low, and exactly what evidence will change our mind about the architecture, is in the [philosophy section of the README](README.md#the-philosophy-a-core-that-stays-still). Read it before proposing anything core-shaped. It is worth knowing up front that we are looking to **replace rather than accumulate**: a proposal that adds a tool and removes nothing has to justify a permanent cost paid by every user on every turn.

### What we are working on next

**Core hardening.** MCP shipped in v1.3 and v1.4, and v1.5 turned to process lifecycle: servers and background jobs that outlived the session, and an interrupt that did not stop queued work. That is the current focus and it continues, subsystem by subsystem, through the parts the agent actually runs on every task.

The method is deliberately unglamorous. Take a subsystem that is already shipped and already has passing tests, read it fresh on the assumption it is wrong, and go looking for the failure shapes this project has been bitten by before, which are written down in [BOUNDARY.md](BOUNDARY.md). The last two passes each found real defects in code with hundreds of green tests. Reproductions from your own machine are worth more here than anything else, because most of what turns up only appears when the thing is genuinely run.

Known MCP gaps, which are not being worked on right now:

* **OAuth for remote servers.** Servers needing authorization report `needs-auth` and stop there. The largest remaining MCP piece and the hardest to verify, since it needs a real identity provider to test against.
* **Multi-round tool requests and elicitation.** A server that needs extra input mid-call cannot ask for it yet.
* **Resources in the prompt box.** Resources are reachable by the agent but there is no way to attach one yourself with `@`.

If any of that is where you want to help, say so in Discussions before writing code so the work does not collide.

### Especially useful right now

**MCP has been tested against one real published server and a set of fixtures we wrote.** Tools have been exercised against a real `npx`-launched server end to end; resources and prompts have not, because nothing we could reach exposes them. Real-world servers will find edges we did not: unusual protocol revisions, odd schemas, servers that behave badly on shutdown. A bug report from a real server is more valuable than a feature right now, and one from a server that actually serves resources or prompts is worth more still.

The same goes for **macOS and Linux**. Development happens on Windows. Both are believed to work and neither is verified.

### 3. Pull Request (PR) Process
1. Fork the repository and create your branch from main:
   git checkout -b feature/your-feature-name
2. Write clean, documented code adhering to the existing codebase structure.
3. Test your changes locally to ensure no regressions: `npm test` and `npm run build` must both be clean.
4. Submit your PR against the main branch with a clear description of the changes made and why.

**If you are fixing a bug, add a test that fails without your fix.** Then check that it does: revert the fix, watch the test go red, and put it back. A test that passes either way is worse than no test, because it makes the next person believe the case is covered. Several guards in this repo exist specifically because a bug could not fail loudly, and those are the ones worth getting right.

---

## AI-Assisted Contributions

AI-generated and AI-assisted code is welcome, we don't gatekeep how you write.

The one rule: **you must fully understand what you're submitting.** Know the problem you're fixing or the feature you're adding, understand why your change works, and be aware of what it affects. Test it before you open the PR. A contribution the author can't explain won't be merged, whether a human or a model wrote it.

---

## Development Rules & Integrity

* Respect License Limits: All contributions are licensed under the Apache License 2.0. Ensure any code you submit is your own or properly compatible.
* No Proprietary Leaks: Share empirical findings, behavioral optimizations, and performance improvements never proprietary code or sensitive internal data.
* Anonymity Supported: If contributing on behalf of personal research or under a secondary handle, your contributions will be reviewed purely on code quality and technical merit.

---

## Community & Questions

Got questions or want to discuss agent orchestration before writing code?
* Drop into our GitHub Discussions.
* Check out active GitHub Issues marked good first issue or help wanted.

Thank you for helping us build an open, high-performance terminal workspace for everyone!
