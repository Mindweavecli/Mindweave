# drivers/ — model drivers (for contributors)

A **driver** is everything Mindweave needs to talk to one model family *well*.

Models are not interchangeable. Claude, DeepSeek, Qwen, and GPT each have their own
best prompt shape, tool-call format, reasoning controls, and caching. A driver is
where one model gets tuned to perform at its best — **without the core engine ever
knowing which model is running.**

The core (`dynamo/`) decides *what* to do — read this file, run that command, make
this edit. A driver decides *how to say it to a specific model.*

---

## One folder per provider

```
drivers/
  README.md         ← this guide
  PROVIDERS.md      ← the user-facing "which models can I use" doc
  deepseek/         ← reference driver
  anthropic/        ← unclaimed
  openai/           ← unclaimed
  qwen/             ← unclaimed
  ollama/           ← unclaimed
```

Each `drivers/<provider>/` folder is **self-contained**. A driver may only import the
shared driver types and its own folder — never another driver, never core internals.
That keeps every driver swappable, and keeps one contributor's changes inside one
folder.

---

## The boundary (what makes it clean, not bloated)

Only the **one** driver the user picked is ever active. If you run DeepSeek, only
DeepSeek's code runs and only DeepSeek's prompt tuning reaches the model — no other
provider's code loads, and no other provider's text is in your context. Adding more
providers never makes any single user's setup heavier — a lean core that stays fast
no matter how many providers exist. This is the whole point.

**A driver owns (for its model):** the HTTP call, request/streaming format, where
prompt-cache breakpoints go, how "think harder" maps to the model, the model list,
per-token pricing, the context-window size, and any model-specific parsing fixes.

**Core owns (never a driver):** the agent loop, the tools and their safety gates,
*what* the system prompt says, memory, and compaction. A driver controls **format,
not craft** — it must never add "how to code" instructions for a model.

Rule of thumb: if a change makes *every* model behave differently, it's core. If it
makes *one* model better and touches nothing else, it's a driver.

---

## The contract

Every driver implements the same small interface; the engine holds one `Driver` and
never sees a provider name:

```ts
interface Driver {
  id: string;                       // "deepseek", "anthropic", …
  models: ModelChoice[];            // what /model lists
  thinkLevels(model): ThinkLevel[]; // what /think lists
  price(model): ModelPrice;         // cache-aware cost
  contextWindow(model): number;     // sharp window → compaction

  toolTurn(req: ModelRequest, opts): Promise<Turn>;
  streamTurn(req: ModelRequest, opts): Promise<StreamResult>;
}
```

`ModelRequest` is already cache-friendly for every provider: a stable prefix
(`system` + `messages` + `tools`) and a volatile tail (`context`) rendered last so it
never breaks a cached prefix. Your driver just renders that split into your
provider's native format and caching.

---

## Workflow — claiming and building a driver

1. **Claim it.** Open an issue to claim `drivers/<provider>/` so two people don't
   build the same one. You become its Driver Lead (listed in `CODEOWNERS`).
2. **Build inside your folder.** Implement the `Driver` contract. Copy `deepseek/`
   as the reference — it's the working example.
3. **Test it locally** against a real key for that provider before opening a PR.
4. **Open a PR.** Changes inside your own driver folder get a light review. Anything
   touching shared types or core always needs core review.

**Security scope (hard rule).** Mindweave runs commands and edits files on a user's
machine. So a Driver Lead's `CODEOWNERS` approval covers *only* their own
`drivers/<provider>/` folder — never shared types, another driver, or core. This is
enforced by the import boundary above and by branch protection, not by trust.

Share empirical findings — prompt formats, tool-loop tweaks, caching wins. Never
paste proprietary or leaked code. The repo is Apache 2.0 and public; treat everything
you add as permanent and world-readable.

---

## Status

The DeepSeek driver currently lives flat in `dynamo/` (`deepseek.ts`, plus its rows
in `model.ts`, `pricing.ts`, `contextWindow.ts`). The shared request/response shapes
there are already provider-neutral. Moving DeepSeek into `deepseek/` behind the
`Driver` interface is the first migration task — deliberately not done yet, so the
structure is simple to start and the community refines it from here.
