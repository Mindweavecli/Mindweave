# dynamo/ — the engine

The reasoning core, and the heart of Mindweave. This is the single agent loop
("one model way") — it generates the power that drives everything else.

**Rule:** the dynamo only *decides* — it never touches the filesystem or runs
commands itself. It takes the session state and returns the next action (a
message to the user, or a tool to run). The CLI carries out those actions.

Keeping the dynamo pure is what lets us later move it to a server (Railway)
without rewriting anything. Everything crossing in/out of the dynamo is plain
JSON.

## Files
- `engine.ts` — the engine step: `respond(history)` returns Mindweave's next reply.
- `deepseek.ts` — the DeepSeek provider client (the actual HTTP call). Other
  providers will each get their own client file later.
