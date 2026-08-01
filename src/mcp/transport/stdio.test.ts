/**
 * stdio.test.ts — framing against a real child process.
 *
 * The framing is the part that fails silently: MCP uses newline-delimited JSON while
 * the language servers elsewhere in this codebase use LSP `Content-Length` headers, and
 * getting it wrong produces a hang rather than an error. So the line splitter is tested
 * as a pure function against the ugly cases a pipe actually delivers, and the transport
 * is then driven end-to-end against a small node script standing in for a server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "./types.js";
import { StdioTransport, drainLines, frame } from "./stdio.js";

test("a frame ends with a newline, or the server waits forever", () => {
  assert.equal(frame({ a: 1 }), '{"a":1}\n');
});

test("drainLines handles the shapes a pipe actually delivers", () => {
  // Several messages in one chunk.
  assert.deepEqual(drainLines('{"a":1}\n{"b":2}\n'), { lines: ['{"a":1}', '{"b":2}'], rest: "" });
  // A message split across chunks: the remainder must be kept, not dropped.
  assert.deepEqual(drainLines('{"a":1}\n{"b":'), { lines: ['{"a":1}'], rest: '{"b":' });
  // Blank lines are noise.
  assert.deepEqual(drainLines("\n\n"), { lines: [], rest: "" });
  assert.deepEqual(drainLines(""), { lines: [], rest: "" });
});

/** A minimal MCP-shaped server: echoes a result, errors on `boom`, prints a banner. */
const FAKE_SERVER = `
process.stdout.write("starting up, not JSON\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "notify_only") { process.stderr.write("got notify\\n"); continue; }
    if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method, params: msg.params ?? null } }) + "\\n");
  }
});
`;

function connect(): StdioTransport {
  return new StdioTransport({ command: process.execPath, args: ["-e", FAKE_SERVER], timeoutMs: 5_000 });
}

test("a request round-trips, and stdout noise is ignored", async () => {
  const t = connect();
  try {
    // The server prints a non-JSON banner first. Servers really do this, and treating
    // it as fatal would break them all.
    const result = (await t.request("tools/list", { a: 1 })) as { echoed: string; params: unknown };
    assert.equal(result.echoed, "tools/list");
    assert.deepEqual(result.params, { a: 1 });
  } finally {
    await t.close();
  }
});

test("concurrent requests resolve to their OWN replies", async () => {
  const t = connect();
  try {
    const [a, b, c] = await Promise.all([t.request("one"), t.request("two"), t.request("three")]);
    assert.equal((a as { echoed: string }).echoed, "one");
    assert.equal((b as { echoed: string }).echoed, "two");
    assert.equal((c as { echoed: string }).echoed, "three");
  } finally {
    await t.close();
  }
});

test("a JSON-RPC error rejects with its code intact", async () => {
  const t = connect();
  try {
    // The code is what `discover.ts` reads to decide a server is pre-stateless, so it
    // has to survive the transport rather than being flattened into a message.
    await assert.rejects(() => t.request("boom"), (e: unknown) => e instanceof RpcError && e.code === -32601);
  } finally {
    await t.close();
  }
});

test("a request times out instead of wedging the turn", async () => {
  // A server that accepts input and never answers. Without the timeout this hangs the
  // agent, which is worse than any error.
  const t = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();"],
    timeoutMs: 150,
  });
  try {
    await assert.rejects(() => t.request("tools/list"), /timeout/);
  } finally {
    await t.close();
  }
});

test("a command that does not exist fails cleanly and reports closed", async () => {
  const t = new StdioTransport({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 2_000 });
  await assert.rejects(() => t.request("tools/list"));
  await t.closed; // resolves rather than hanging
  await t.close();
});

test("a dead server fails in-flight requests instead of leaving them pending", async () => {
  const t = new StdioTransport({ command: process.execPath, args: ["-e", "process.exit(0);"], timeoutMs: 5_000 });
  await assert.rejects(() => t.request("tools/list"), /exited|closed|start/);
  await t.close();
});

test("requests after close are refused, not silently dropped", async () => {
  const t = connect();
  await t.close();
  await assert.rejects(() => t.request("tools/list"), /closed/);
});
