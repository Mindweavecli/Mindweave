/**
 * config.test.ts — a bad config must cost you MCP, never the session.
 *
 * This file is read before anything else works, so every case here is really the same
 * question: can a user's typo stop the agent from starting? The answer has to be no,
 * which is why the parse drops entries instead of throwing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEntry, parseMcpConfig } from "./config.js";

test("a stdio server is inferred from `command`, with no type needed", () => {
  const [server] = parseMcpConfig(
    JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@x/fs"], env: { TOKEN: "t" } } } }),
  );
  assert.deepEqual(server, { type: "stdio", name: "fs", command: "npx", args: ["-y", "@x/fs"], env: { TOKEN: "t" } });
});

test("an http server is inferred from `url`", () => {
  const [server] = parseMcpConfig(JSON.stringify({ mcpServers: { api: { url: "https://x.dev/mcp", headers: { a: "b" } } } }));
  assert.deepEqual(server, { type: "http", name: "api", url: "https://x.dev/mcp", headers: { a: "b" } });
});

test("both `mcpServers` and `servers` are accepted", () => {
  // Both spellings exist in the wild; rejecting one looks like the file being ignored.
  assert.equal(parseMcpConfig(JSON.stringify({ mcpServers: { a: { command: "x" } } })).length, 1);
  assert.equal(parseMcpConfig(JSON.stringify({ servers: { a: { command: "x" } } })).length, 1);
});

test("malformed JSON yields no servers instead of throwing", () => {
  // The whole point: a broken file degrades to "no MCP", not "no agent".
  assert.deepEqual(parseMcpConfig("{not json"), []);
  assert.deepEqual(parseMcpConfig(""), []);
  assert.deepEqual(parseMcpConfig(JSON.stringify({ mcpServers: [] })), []);
  assert.deepEqual(parseMcpConfig(JSON.stringify({})), []);
});

test("one broken entry does not take the good ones with it", () => {
  const servers = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        good: { command: "npx" },
        noCommand: { args: ["x"] },
        alsoGood: { url: "https://x.dev/mcp" },
        notAnObject: "nope",
      },
    }),
  );
  assert.deepEqual(servers.map((s) => s.name).sort(), ["alsoGood", "good"]);
});

test("non-http URLs are refused", () => {
  // A `file://` or custom scheme here points the client at something that is not an
  // MCP endpoint at all.
  assert.equal(parseEntry("x", { url: "file:///etc/passwd" }), null);
  assert.equal(parseEntry("x", { url: "ftp://x.dev" }), null);
  assert.ok(parseEntry("x", { url: "http://localhost:3000/mcp" }));
});

test("deprecated transports are refused rather than half-supported", () => {
  // HTTP+SSE was deprecated in 2025-03-26 and its sunset has passed.
  assert.equal(parseEntry("x", { type: "sse", url: "https://x.dev" }), null);
  assert.equal(parseEntry("x", { type: "ws", url: "wss://x.dev" }), null);
});

test("disabled is carried through so the pool can skip without forgetting", () => {
  const server = parseEntry("x", { command: "npx", disabled: true });
  assert.equal(server?.disabled, true);
  // A server that is merely off must still be listed, or `/mcp` cannot show it.
  assert.equal(server?.name, "x");
});

test("non-string args, env and header values are dropped, not coerced", () => {
  const server = parseEntry("x", { command: "npx", args: ["ok", 5, null], env: { good: "1", bad: 2 } });
  assert.deepEqual(server && "args" in server ? server.args : null, ["ok"]);
  assert.deepEqual(server && "env" in server ? server.env : null, { good: "1" });
});

test("an unnamed entry is dropped", () => {
  assert.equal(parseEntry("", { command: "npx" }), null);
});
