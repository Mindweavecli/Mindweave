# Before you build: universal or driver?

**Read this before writing any code in this repo.** Every fix, every feature, every
bug. It takes a minute and it exists because skipping it has already cost us real
bugs, listed at the bottom.

MindWeave runs several model providers through one engine. That only works if two
things stay true:

- **Core never knows which model is running.** It owns the agent loop, the tools,
  their safety gates, what the system prompt says, memory, and compaction.
- **A driver never teaches a model how to work.** It owns one provider's wire
  format, request shape, cache breakpoints, model list, prices, context window, and
  any parsing repairs that provider needs.

A driver controls **format, not craft**. The system prompt is byte-identical
whichever provider you pick. If that stops being true, the architecture is gone and
every provider added afterwards makes the product worse instead of better.

---

## The three questions

Answer all three, in order, before writing code. If you are working with an AI
agent in this repo, it must give you these answers **before** it starts, not after.

### 1. Should this exist at all?

The default answer is **no**. This project is deliberately finished at the core and
the bar for adding to it is high.

Say yes when:

- it fixes a **reproduced** bug, and you can state what you observed
- it closes a correctness gap you can demonstrate with a failing test
- it is a new **driver** (those are additive and cost the core nothing)

Say no when:

- it is a feature nobody hit a wall without
- it is a guess at what a model might need
- it makes core bigger to work around one model's behavior (see question 2)

Being able to build something is not a reason to build it. A smaller core that does
its job well beats a larger one that does more.

### 2. Where does it go?

One test decides it:

> **If a different provider were the only one installed, would this still be
> correct and still be needed?**

- **Yes** → core.
- **No** → `drivers/<provider>/`.
- **Unsure** → it is a driver. Wrong-in-a-driver affects one provider;
  wrong-in-core affects all of them and every future one.

Faster signals:

| Signal | Goes in |
|---|---|
| Names a provider, model id, endpoint, or wire field | driver |
| Compensates for how one model behaves | driver, or nowhere (see below) |
| Would become dead code if that provider were removed | driver |
| Is about files, sessions, tools, safety, or the user's project | core |
| Every provider needs it and none needs it differently | core |

**The trap.** "This model keeps doing X, add an instruction telling it not to" feels
like a core prompt change. It is not. It is one model's crutch, and core hands it to
every other model that never needed it. Prefer fixing it in the driver, or accepting
the behavior, or concluding the model is wrong for the job. Instructions to core
that exist because of one provider are the main way this architecture rots.

### 3. What breaks for the other providers?

If the answer to question 2 was **core**, you must answer this one too.

- Does it assume a field, value, default, or behavior that only one provider has?
- Does it add prompt text every model will now read, whether or not it needs it?
- Does it use a vocabulary term (an effort level, a stop reason, a role) that some
  provider does not accept? Shared types are the **union** of every provider's
  vocabulary, so a value being in the type does **not** mean your provider takes it.
- If a provider fails this, does it fail loudly, or does it silently do nothing?

Silent is worse than loud. A rejected request gets noticed. A value quietly ignored
can sit there for weeks.

---

## The report, before any work starts

State this and get agreement before writing code:

```
What:        one line, plainly.
Should we:   yes / no, and why. Evidence if it is a bug.
Where:       core  |  drivers/<provider>
Why there:   answer to the "different provider" test.
Risk:        what could break for other providers, or "none, driver-local".
Verify by:   the check that proves it works, and the check that proves
             it did not break anyone else.
```

If "Where" is core and "Risk" is empty, the risk section was not thought about.
There is always something, even if the answer is that it is genuinely universal.

---

## Before you call it done

- `npm run typecheck` clean
- `npm test` clean, with the **new test that fails without your change** (write it,
  watch it fail, then fix it; a test that never failed proves nothing)
- if you touched a driver: every **other** provider's tests still pass
- if you touched core: name which providers are affected and why that is fine
- if you added prompt text: state which models now read it and why each needs it

---

## Traps we have actually hit

Not hypothetical. Each of these shipped or nearly shipped.

**A shared type is not a permission slip.** `Effort` is the union of every
provider's ladder (`low | medium | high | xhigh | max`). DeepSeek accepts only
`low | high | max`. Pro's "Maximum" sent `xhigh` for weeks and did nothing, because
`xhigh` is Anthropic's rung and type-checked fine. A driver must clamp to its own
accepted set in `normalize()` and test it.

**Omitting a field is not the same as disabling it.** DeepSeek defaults `thinking`
to *enabled* when the field is absent, so "Standard" mode silently ran full
reasoning on every call, including internal ones. Send the explicit value. Read the
provider's documented default rather than assuming absence means off.

**Search and shell walk around per-file gates.** `read_file` refused `.env` while
`grep -r` printed its contents and `cat .env` read it whole. If you gate a file,
gate every path to its contents, not just the obvious one.

**Enumerating names does not generalize.** A deny-list of competitor tool
directories is always one tool behind and encodes their names in your source
forever. Prefer a boundary the project itself declares.

**Behavioral instructions in core are one model's crutch.** The reliability rules in
`dynamo/prompt.ts` were written as "universal" when there was exactly one provider,
so universal and DeepSeek were the same set. They are not anymore. Anything that
tells a model *how to behave* deserves the question 2 test.

This has since been audited and acted on. Two lines were removed: one telling the
model not to repeat a summary (written for an observed failure, and captured
transcripts show the model doing it anyway, with the line present), and one telling
it not to blindly retry (already enforced deterministically by `REPEAT_FAIL_LIMIT`).
The lesson generalizes: **a sentence the model ignores costs every provider and
helps none.** When one model misbehaves, prefer a mechanical guard, because the harness can
enforce, a sentence can only ask. `promptAssembly.test.ts` now asserts those lines
stay gone.

**Core must never name a model id.** `/model`'s autocomplete described "DeepSeek V4
Flash / Pro" long after a second provider had shipped four models, plainly false,
and read by the user every session. The `/think` overlay separately fell back to a
hardcoded `"deepseek-v4-flash"`. Both type-checked, both passed every test, and
neither could ever throw. Provider identity leaks into the **UI layer** as readily as
into the prompt, and audits that only look at `prompt.ts` miss it entirely.
`providerNeutrality.test.ts` scans all of core for model ids and is the guard.
Read model names from the registry (`allModels()`, `DEFAULT_MODEL_CONFIG`), never
from a literal.

**A prompt line that was true when written becomes a lie, and the model obeys it.**
The prompt told the model *"You cannot see what was said in [your past sessions]
from here… tell them `/continue` resumes a past session."* That was accurate when
nothing could read a transcript. The sessions, the loaders, and the need all existed
long before anyone revisited the sentence. Asked what happened last session, the
model dutifully refused to look and paraphrased a project file instead. It read as a
stupid model. It was an obedient one following a stale instruction. Prefer pointing
at a tool (`call list_sessions`) over asserting an absence: a dead tool pointer fails
loudly, a false negative claim never fails at all. Any sentence describing what the
agent *cannot* do needs a test pinning it, so shipping the capability turns that test
red, which is exactly how this one was finally caught.

**Hardcoded UI strings are the same bug wearing different clothes.** The banner read
`v0.0.1` for three releases while `package.json` said otherwise. `/model` described
"DeepSeek V4 Flash / Pro" long after four models across two providers existed. Both
type-check, neither can throw, every test passed. The pattern is always a literal
standing in for something that has a real source of truth, in a place no assertion
looks. Read from the source (`package.json`, `allModels()`, `DEFAULT_MODEL_CONFIG`),
and guard it with a test that compares the two. `version.test.ts` and
`providerNeutrality.test.ts` are those guards.

**A test fixture can be the one input that does not hit the bug.** The stdio transport
spawned MCP servers by name, and every test drove it with `process.execPath`, which is
an absolute path to a real `.exe`. On Windows that is the single shape that works
without a shell. Every other shape, including `npx`, which is how nearly every MCP
server in existence is configured, failed with `ENOENT` on the platform this project is
developed on. Twelve tests passed for a feature that could not start a real server. When
a test constructs its own input, ask what makes that input convenient, and whether
convenience is what makes it work.

**A check that runs once guards a moment, not a property.** Tool descriptions were
fingerprinted when a server connected, which reads like protection against a server
changing its descriptions. It is not. It is protection against a server that had already
changed them *before* connecting. A server that connected clean and then announced a new
tool list had the new descriptions loaded unexamined, which is the precise attack the
fingerprints exist to catch. When a guard runs at one point in a lifecycle, write down
which events can move the thing it guards, and check that each one re-enters the guard.

---

## Where things live

```
src/dynamo/     the agent loop, prompt, compaction   ← core
src/tools/      tools and their safety gates          ← core
src/memory/     sessions, memory, working set         ← core
src/cli/        the terminal UI                       ← core
src/drivers/    types.ts + registry.ts                ← core (the seam)
src/drivers/<provider>/                               ← that provider only
```

`src/drivers/README.md` has the full driver contract and the manifest/driver split.
`registry.test.ts` enforces the boundary and is the test a new provider must keep
passing.
