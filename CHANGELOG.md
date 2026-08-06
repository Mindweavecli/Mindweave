# Changelog

Notable changes to Mindweave. Dates are release dates.

The 1.x line is the build-in-the-open phase. The next milestone is Release 1, when
Mindweave lands on npm and the numbering resets. Between here and there: no new
features, just real use and fixing whatever that turns up.

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

## Earlier releases

Release notes for v1.0 through v1.9.0 are on the
[releases page](https://github.com/mindweave-cli/Mindweave/releases). The short version:
the Anthropic driver alongside DeepSeek, providers loaded on demand, sessions the agent
can read back, MCP with protection against changed tool descriptions, rebuilt editing
tools, per-model compaction, background jobs that report when they are up, undo that will
not overwrite your own work, images you can attach and have looked at, and POSIX process
handling.
