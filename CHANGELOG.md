# Changelog

Notable changes to Mindweave. Dates are release dates.

The 1.x line is the build-in-the-open phase. The next milestone is Release 1, when
Mindweave lands on npm and the numbering resets. Between here and there: no new
features, just real use and fixing whatever that turns up.

---

## v1.9.3 (2026-08-07): the same answer either way, and installs that cannot hang

Mostly about search and indexing telling the truth, plus the first automated test runs.

### Search gave different answers depending on your machine

Mindweave searches with ripgrep when it is installed and with a built-in walker when it
is not. Only ripgrep respected `.gitignore`, while both tools described that behaviour as
though it always applied. The same query on the same project therefore returned different
results on two machines, and nothing in the reply said which engine had answered.

The built-in walker now honours `.gitignore` too: nested ignore files, negated rules,
directory-only rules, and last-match-wins precedence. An unsupported rule is treated as
matching nothing, so the walker errs toward showing a file rather than hiding one, since
a wrongly hidden file looks exactly like a file that does not exist.

Symlinked directories are now skipped deliberately rather than by accident. They used to
fall through an `isDirectory`/`isFile` check and vanish with no decision behind it.
Ripgrep does not follow them either, and code that lives elsewhere is better added as a
workspace root with `/link`, which labels and indexes it properly.

### The code map indexed files every other tool refuses to open

`definition`, `references`, `relevant` and the folder rollup all read out of the code
map, and the code map was built from an unfiltered walk. So symbols from `.env`-adjacent
files and from other coding agents' directories could be surfaced by a lookup, even
though `read_file`, `grep` and `glob` all decline those paths directly. The exclusion is
now applied when indexing, at the source, rather than at each query.

### Answers that claimed more certainty than they had

* `references` asked the language server about only the first definition of a name, then
  reported the result as compiler-resolved. A name defined in three places returned one
  set of callers with full confidence. It now covers every definition and removes
  duplicate call sites.
* A symbol the language server confirms has no callers is now reported as unused. It
  previously fell back to matching the name as text, which invented callers for it.
* In a multi-root workspace, a merged list is only labelled resolved when every root
  resolved it. One root running a language server no longer vouches for a root that is
  not, which had been suppressing the "verify this" note on the half that needed it.
* `outline` on a large directory now says how many files it actually covered. It stops
  after 40, and a partial survey that does not say so reads as the shape of the whole
  folder.

### Sessions that hung, and processes that piled up

Installing a language server ran `npm install` with no timeout and never killed it, and
downloads had no deadline. A stalled install waited forever, left its process tree
running, and because installs are shared, handed that same never-finishing wait to
everything that asked afterwards. This is why fresh project directories could hang for
ten minutes or more while background processes accumulated: a fresh directory is exactly
when a server gets installed, and a warm one skips the step.

Every step now has a deadline and kills its whole process tree when it expires. A failed
install is a normal outcome that leaves the language on the tree-sitter tier, which
works.

### Tests now run automatically

There is a CI workflow, running on Windows on Node 20 and 22.

macOS and Linux were tried and then removed again. The suite does not fail there, it
HANGS: the test step ran past fifteen minutes with no end while the same suite finished
on Windows in three. That points at process handling which has only ever been exercised
on one platform. Reporting a hang nobody is working on says nothing about whether a
change is good, so those jobs come back with the work that makes them pass. Windows is
the supported platform today, and the README says so plainly.

The suite's intermittent crash under load was diagnosed rather than worked around: it is
`Fatal process out of memory: Zone`, caused by the size of the OCaml grammar rather than
by test scheduling. It survived forcing single-file concurrency, and it followed the
OCaml cases when they were moved between files. Test runs now have heap headroom, and
the grammar-heavy files run in their own sequential phase. The language cases were also
rebalanced by grammar size, with a guard test that fails if that balance drifts.

---

## v1.9.2 (2026-08-07): what it says, and what it reads twice

Two problems, both found by running the agent on a real project rather than by reading
code. Neither could fail a test, which is why they survived nine releases.

### The agent talked more than it worked

A turn that made 23 tool calls printed 24 paragraphs of narration. Each one was short,
but two dozen of them is a wall, and the same function names came round in four
separate blocks: a plan stated, then restated, then restated again.

The cause was in the system prompt, which said the user could not see tool calls, and
then demonstrated `"Let me read the file."` as the house style. Both were wrong. Every
tool call is rendered on screen as it happens. So the model was being told to narrate
work the user was already watching, and shown an example of how.

* The prompt now states what is actually true: your text sits alongside a visible record
  of every call, so it has to add to that record rather than repeat it.
* **One line of narration per turn**, enforced where it renders rather than requested in
  prose. However many tool calls a turn takes, the tool rows are the progress indicator.
* Final answers now match the question. A finished task gets a line or two. A question
  that genuinely asks for an account ("what did we do last session", "why did that
  break") gets as many plain paragraphs as the answer needs. Headings, bullet lists and
  status recaps on a short answer are gone.

### The same lines were paid for repeatedly

Files the agent is working on are rebuilt into its context every turn. `read_symbol`
did not check that, so it re-sent a function body that was already on screen. Ranged
`read_file` had the same hole for large files, which are shown as focused regions
rather than whole. One session read the same file four separate times while its
contents sat in front of the model.

* Both now compare the request against what the working set **actually rendered this
  turn**, and point at it instead of re-sending. Checked against what was drawn, never
  against a record of what was read once: a stale claim that the model already has
  something is far worse than a wasted read, and a sub-agent has no working set at all.
* An edited file is always re-sent. Freshness beats saving tokens.

### Also

* A saved session whose tool calls and their results were stored out of order could not
  be resumed at all. Those are now repaired on load, with nothing dropped.
* Reminders the engine writes to itself (verify your changes, batch these edits) were
  indistinguishable from something you typed. They showed up as your own prompts in a
  resumed chat, and one could become the session's title in `/continue`. They are marked
  as engine-written and no longer surface as yours.
* `scripts/narration.mjs` reports how much a session talks against how much it does:
  prose per tool call, how many blocks ran over budget, and which identifiers were
  discussed in three or more separate blocks. Useful if you are working on this area.

---

## v1.9.1 (2026-08-07): tool audit

Every one of the 36 tools the agent can call was read against its own implementation,
one at a time. The rule for the pass was simple: read the code before writing a word
about it. Every defect below was invisible from the description alone.

Two causes accounted for nearly all of it. Some descriptions were accurate when written
and were never updated as the tool grew. Others were written as a one-line summary of a
feature and never revisited. Descriptions written against an observed failure were the
accurate ones, which is a useful thing to know when writing the next one.

21 of the findings were code, not wording.

### Answers that were quietly wrong

* **`diagnostics` checked the wrong files.** With no path given it picked the files to
  check by insertion order rather than recency, so the file you had just edited was
  skipped. It then reported "No diagnostics" while naming files it had never looked at.
* **`list_dir` showed a symlinked directory as a file.** A directory reached through a
  symlink or junction reports as neither a file nor a directory, so the trailing slash
  that tells them apart never appeared. Common in `node_modules/.bin` and linked
  monorepo packages. Symlinks are now marked, and a broken one says so.
* **`list_dir` said "directory not found" when pointed at a real file**, which sent the
  agent looking for something it had already located. Missing, is-a-file and
  permission-denied are now told apart.
* **`find_mcp_tools` silently returned only the first 8 matches.** Search is the only way
  to reach a large MCP catalog, so the tools it did not return also stayed unloaded and
  invisible. It now says when it hit the limit.
* **`list_mcp_resources` and `read_mcp_resource` disagreed about server names.** For some
  configured names the listing rejected the exact name the read accepted.

### Data that could be lost

* **Skill bodies were corrupted.** Placeholder substitution treated any `$` followed by
  digits as an argument, so `$100` became empty and, with no arguments passed, every
  `$1` in the body was deleted. A skill containing `awk '{print $1}'` silently became
  `awk '{print }'`. The steps the agent followed were not the steps on disk.
* **Saving one memory could delete another.** The index updater removed any line
  containing the saved file's name, so an entry whose text referenced another memory was
  deleted when that memory was next saved.
* **Two memory names that reduce to the same filename silently replaced each other.**
  Saving is deliberately not confirmed with you because memory is non-destructive; this
  was the one case where that was untrue, and it is now reported.
* **A standing rule could exist twice in a session and once on disk**, so a rule you had
  just set appeared to vanish on restart.
* **Frontmatter injection in three writers.** Memory, rules and skills all wrote
  user-supplied text into a line-oriented header that is read back and trusted. A line
  break in a name or description could forge fields, for example re-scoping a rule to
  every file. No malice required; a pasted title does it.

### Consent

* **Pressing Escape on a question returned the second option as your answer.** Correct
  for a yes/no prompt, wrong for `ask_user`, where the options are arbitrary. Dismissing
  "Postgres or SQLite?" told the agent you had chosen SQLite.
* **Sub-agents could put approval dialogs on your screen.** A parallel fan-out could
  stack several with nothing to say which agent asked. Sub-agents now proceed on a
  sensible default and report the assumption, which is what their briefing already
  assumed.
* **`add_directory` and `link_workspace` treated "no way to ask" as permission granted**,
  on the widest change either makes: pulling every discovered sibling repository into the
  workspace. Both now decline and say so.
* **`add_mcp_server` did not say what it was about to do.** It asked to "add" a server
  while replacing an existing one of the same name, and never mentioned that credentials
  were being written to a config file. Both are stated before the question now, naming
  the credential keys but never their values.

### Accuracy

* **`add_mcp_server` recommended something that cannot work.** It told the agent to
  reference an environment variable, with `"$TOKEN"` as the example. Nothing expands that,
  so it reached the server as those literal characters and failed as a bad credential.
  The server already inherits your environment, so a variable already set in your shell
  needs no entry at all.
* **`add_directory` could add the same folder several times** under different labels,
  because paths were compared as text. A case variant or a symlink produced a second
  root, and searches then walked the same tree twice.
* **`glob` listed secrets that every other tool refuses.** `read_file` declines `.env`,
  `grep` never searched it, `glob **/*` listed it.
* **MCP resource template listings were unbounded**, so a server could put as much into
  your context as it liked.
* **`link_workspace` reported only its successes**, so a partial link read as a complete
  one.
* Background shell output that had been dropped to stay within its buffer was recorded as
  truncated and never shown, so an incomplete log looked complete.

### Descriptions

The other 15 findings were wording, but the kind that changes behaviour: caps that were
enforced and never stated, results that looked identical whether they meant "clean" or
"I could not check", and tools that promised more certainty than they had. Every stated
number is now pinned to the constant it describes, so prose cannot drift from the code.

---

## v1.0 to v1.9.0

This changelog starts at v1.9.1. Earlier versions were released as commits rather than
tagged releases, so the detail lives in `git log`. What landed across that line:

* **v1.1** the Anthropic driver alongside DeepSeek, and providers loaded on demand
* **v1.2** sessions the agent can read back, so "what did we do last time" gets a real
  answer
* **v1.3, v1.4** MCP, including protection against a server changing a tool's description
  after you trusted it
* **v1.5** rebuilt editing tools and per-model compaction
* **v1.6** background jobs that report when they are actually up, not just when they exit
* **v1.7** undo that will not overwrite your own edits, and `/provider` split from
  `/model`
* **v1.8** images you can attach and have looked at
* **v1.9.0** core hardening, subsystem by subsystem, and POSIX process handling. Feature
  freeze starts here.
