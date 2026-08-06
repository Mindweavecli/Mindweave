# Connecting MCP servers

[MCP](https://modelcontextprotocol.io) servers give the agent tools Mindweave does not ship: issue trackers, databases, cloud APIs, internal services. Add one and it is available from that moment on, in every future session, with nothing to start by hand.

## Adding a server

```bash
# a local server
/mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=ghp_x

# a remote one
/mcp add --http internal https://tools.acme.dev/mcp --header 'Authorization: Bearer t'

# available in every project, not just this one
/mcp add --global notes npx -y some-notes-server

# a server with its own flags: everything after -- goes to the server
/mcp add mine my-server -- --port 9000 --verbose

/mcp             # what's running, and reconnect anything that isn't
/mcp remove x    # stop configuring it
```

You can also just ask: *"add the github mcp server, my token's in GITHUB_TOKEN."* The agent writes the config and asks you to confirm before anything is saved.

## Where the config lives

Servers are declared in `.mindweave/mcp.json` (this project) or `~/.mindweave/mcp.json` (everywhere), in the same format every other MCP client uses, so an existing config can be pasted straight in.

## Two things worth knowing

**A changed tool description blocks the tool.** If a server's tool description changes between sessions, that tool is held until you approve it. A changed description is the main way a server you already trusted turns hostile, so this is treated as a decision for you rather than a detail to absorb quietly.

**OAuth is not supported yet.** Remote servers that require it will show as `needs-auth`.

## Large tool catalogs

A server advertising many tools does not get to flood the model's tool list. Beyond a threshold its tools go into a deferred pool that the agent searches on demand, so a big catalog costs a search rather than a permanent slice of every request.

## Reporting problems

MCP is the youngest part of Mindweave and the part most likely to meet a server we have never seen. Resources and prompts have mostly been driven against servers written in-house, so real ones will find edges. Bug reports here are unusually valuable.
