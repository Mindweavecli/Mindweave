# The philosophy: a core that stays still

This document is permanent. It is the clearest statement of how this project is run, and it is here so nobody has to guess before they open an issue or write a line of code.

**Mindweave is open to everyone for suggestions. The core is not open to everything.**

Anyone can propose anything. Issues, discussions, pull requests, all welcome, and a good idea from a first-time contributor carries exactly as much weight as one from a maintainer. What differs is where the idea lands, because this project has two very different bars.

**Drivers are wide open.** Everything that makes one model family run at its best belongs in `/drivers/<provider>`: wire format, request shape, cache breakpoints, prices, context windows, parsing repairs. Models ship faster than anything else in this field, and the driver layer is designed to absorb that churn without the middle of the agent moving at all. If you want to change something, this is almost always where it should go, and the answer here is usually yes.

**The core is deliberately near-finished, and the bar to change it is high on purpose.** The agent loop, the tools, their safety gates, the system prompt, memory, and compaction are the parts every provider and every user depends on. They change when there is a reproduced bug, a demonstrated correctness gap, or a genuinely better architecture that has been measured against the current one. They do not change because something is fashionable, because another tool shipped it, or because it might be useful to somebody.

This is the same shape that has kept other long-lived systems alive. The Linux kernel holds a hard line against breaking userspace, and has for decades, while drivers underneath churn constantly. The stability is not stagnation. It is what makes everything built on top of it safe to rely on. A tool that rewrites its foundations every time the field moves is a tool nobody can build a habit around.

## What gets added

One test, and it is not about whether an idea is clever:

> Does this make the developer spend less, get better results, and work faster and more smoothly?

If it does not clearly do at least one of those, with the others not made worse, the answer is no. That is not a lack of ambition. Every capability in the core is paid for by every user on every turn, forever, and most of the cost is invisible at the moment it is added.

## Replacing beats adding

**We are looking to replace, not to accumulate.** Every tool has a real price: its description and schema are sent to the model on every uncached turn, so a tool nobody uses still costs tokens on every request from everyone. It also costs something worse than tokens. A model choosing among a large set of tools chooses worse than one choosing among a small set, whatever the context window allows, so each addition slightly degrades every decision the agent makes about the tools that were already there.

So the preferred shape of a good contribution is: this replaces that, and here is why the result is smaller, faster, or more correct. A proposal that adds a capability and removes nothing has to justify its permanent cost to everyone, not just its benefit to the person proposing it.

## Universal, or not in the core

A capability belongs in the core only if it can be universal there. When a provider cannot do something, the driver says so and the core degrades cleanly. What we do not do is build a second implementation so the weaker provider can catch up, because that is a second thing to maintain, a second way to fail, and usually a second credential for the user to go find.

The bar is `web_fetch`: plain local code, no key, works everywhere because it never needed a provider to exist. Meet that bar or it does not ship in the core.

## Got some core idea?

Bring evidence, not preference. A better architecture is genuinely welcome and will be taken seriously, on these terms:

- Show what is slow, wrong, or clumsy about the current design, with something reproducible.
- Show that the alternative is actually better, measured against what exists now rather than against an idea of it.
- Show what it costs: tokens, complexity, surface area, and what it means for every provider rather than the one you use.

If the numbers say the current architecture is worse, it changes. That has already happened more than once in this project, and each time it was because someone measured rather than argued. What will not move it is "most tools do it this way" or "it would be nice to have".

Open a Discussion before writing code for anything core-shaped. We will talk it through, and where it makes sense we will test it properly and let the result decide. Being told no early is a better outcome than spending an afternoon on something that was never going to be merged, and this is written down precisely so that conversation can start honestly.

---

The architectural rules this philosophy turns into, the ones the code is actually held to, live in [BOUNDARY.md](BOUNDARY.md).
