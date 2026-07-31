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

### 3. Pull Request (PR) Process
1. Fork the repository and create your branch from main:
   git checkout -b feature/your-feature-name
2. Write clean, documented code adhering to the existing codebase structure.
3. Test your changes locally to ensure no regressions.
4. Submit your PR against the main branch with a clear description of the changes made and why.

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
