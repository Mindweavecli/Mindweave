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
  types.ts          ← the shared contract (the only shared import a driver may use)
  registry.ts       ← the one file that knows which providers exist
  deepseek/         ← reference driver
    manifest.ts     ← models, reasoning levels, prices, window  (always loaded)
    index.ts        ← assembles the Driver                      (loaded on demand)
    client.ts       ← the wire format: HTTP + streaming
    inlineTools.ts  ← a model-specific parsing repair
  anthropic/        ← Claude, via the official SDK
    manifest.ts
    index.ts
    client.ts
  openai/           ← unclaimed
  qwen/             ← unclaimed
  ollama/           ← unclaimed
```

**Two halves, loaded at different times.** `manifest.ts` is cheap metadata that is
loaded for *every* provider, because the `/model` and `/think` pickers and the
cost and compaction math need it before the user has chosen anything. Everything
else, including any SDK, sits behind a dynamic import and loads only once one of
your models is actually selected. So keep `manifest.ts` to plain data and pure
functions: no SDK import, no network, no work at module load.

Each `drivers/<provider>/` folder is **self-contained**. A driver may only import the
shared driver types and its own folder — never another driver, never core internals.
That keeps every driver swappable, and keeps one contributor's changes inside one
folder.

---

## The boundary (what makes it clean, not bloated)

Only the **one** driver the user picked is ever active. If you run DeepSeek, only
DeepSeek's prompt tuning reaches the model: no other provider's text is in your
context, and no other provider's behavior is in the loop. Adding providers never
makes any single user's setup heavier. That is the whole point of the split.

This is enforced, not aspirational: providers load through dynamic imports, so
selecting a DeepSeek model never brings Anthropic's SDK off disk (~3ms versus
~85ms — see Status below).

**A driver owns (for its model):** the HTTP call, request/streaming format, where
prompt-cache breakpoints go, how "think harder" maps to the model, the model list,
per-token pricing, the context-window size, and any model-specific parsing fixes.

**Core owns (never a driver):** the agent loop, the tools and their safety gates,
*what* the system prompt says, memory, and compaction. A driver controls **format,
not craft** — it must never add "how to code" instructions for a model.

Rule of thumb: if a change makes *every* model behave differently, it's core. If it
makes *one* model better and touches nothing else, it's a driver.

The full version of that decision, including what breaks for other providers and
the traps we have already hit, is in [BOUNDARY.md](../../BOUNDARY.md) at the repo
root. Read it before your first change.

---

## The contract

Every driver implements the same small interface; the engine holds one `Driver` and
never sees a provider name:

```ts
// manifest.ts — cheap, always loaded
interface DriverManifest {
  id: string;                       // "deepseek", "anthropic", …
  models: ModelChoice[];            // what /model lists
  thinkLevels(model): ThinkLevel[]; // what /think lists
  price(model): ModelPrice;         // cache-aware cost
  contextWindow(model): number;     // sharp window → compaction
  normalize(cfg: ModelConfig): ModelConfig;  // coerce a saved/unknown selection
}

// index.ts — the wire half, loaded only when your provider is selected
interface Driver extends DriverManifest {
  toolTurn(req: ModelRequest, opts): Promise<Turn>;
  streamTurn(req: ModelRequest, opts): Promise<StreamResult>;

  sanitizeText?(raw: string): string;        // optional: repair leaked markup
}
```

`normalize` is how a provider stays authoritative over its own id space: core hands
it whatever was saved in the project config (possibly a model that no longer
exists, or a reasoning level this model doesn't offer, or a combination the API
rejects) and you return something you can actually serve. It is also where you
enforce per-model rules — the Anthropic driver uses it to make sure no-thinking is
never paired with an effort level Opus 5 refuses, so that never reaches the wire.

`sanitizeText` is only needed if your provider leaks markup into the text channel —
the live UI renders raw deltas, so that is the one place a finished turn's cleanup
doesn't reach. Most providers don't need it.

`Effort` (`low` | `medium` | `high` | `xhigh` | `max`) is the union of every
provider's ladder, not one provider's. Offer only the rungs your models accept and
clamp the rest in `normalize`; DeepSeek exposes two of the five, Anthropic all
five. A level you advertise in `thinkLevels` must survive `normalize` unchanged —
`registry.test.ts` checks that, because otherwise picking it in `/think` would
silently give the user a different one.

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

Two providers ship: **DeepSeek** and **Anthropic**. The seam is real rather than
planned — no file outside `drivers/` imports a provider, and core reads the model
list, reasoning levels, prices, and context window from whichever manifest owns the
selected model. `registry.test.ts` enforces that boundary and is the test the next
provider has to keep passing.

Loading is lazy and measurably so: selecting a DeepSeek model costs ~3ms, selecting
a Claude model ~85ms because that is when the Anthropic SDK comes off disk. A
DeepSeek user never pays for Anthropic's code, and that stays true however many
providers are added.

Adding a provider means one entry in `MANIFESTS` and one in `LOADERS` in
`registry.ts`. Nothing else in the codebase changes.

**Next up: OpenAI.** It is OpenAI-compatible, so `deepseek/client.ts` is much closer
to the right starting point than `anthropic/client.ts` is. Copy that folder, keep
the manifest/driver split, and open an issue to claim it.
