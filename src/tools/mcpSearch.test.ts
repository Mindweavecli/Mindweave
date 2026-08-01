/**
 * mcpSearch.test.ts — the door into a deferred catalog.
 *
 * The failure this guards is subtle: whatever the tool says back, the model has to draw
 * the right conclusion from it. A message that reads as "that failed" makes a model stop
 * searching and start guessing, which is exactly what the deferred pool exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMcpTools } from "./mcpSearch.js";
import { McpManager } from "../mcp/manager.js";
import type { ToolContext } from "./types.js";

const ctxWith = (mcp?: McpManager): ToolContext => ({ mcp }) as unknown as ToolContext;

function fakeServer(count: number): string {
  return `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "server/discover") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: {} } }); continue; }
    if (msg.method === "tools/list") {
      const tools = [];
      for (let i = 0; i < ${count}; i++) tools.push({ name: "tool_" + i, description: "does thing " + i });
      tools.push({ name: "create_issue", description: "Open a new issue" });
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
}

async function poolOf(count: number): Promise<McpManager> {
  const mgr = new McpManager();
  await mgr.start([{ type: "stdio", name: "big", command: process.execPath, args: ["-e", fakeServer(count)] }]);
  return mgr;
}

test("the tool is read-only and always present", () => {
  assert.equal(findMcpTools.readOnly, true);
  assert.equal(findMcpTools.name, "find_mcp_tools");
});

test("with no servers it says so plainly and points back to built-ins", async () => {
  const r = await findMcpTools.execute({ query: "github" }, ctxWith());
  assert.equal(r.isError, undefined, "no servers is a normal answer, not an error");
  assert.match(r.output, /No MCP servers/);
});

test("when nothing is deferred it tells the model not to bother", async () => {
  // Returning a result list here would teach the model it must search before calling
  // tools that are already sitting in its tool list.
  const mgr = await poolOf(2);
  try {
    const r = await findMcpTools.execute({ query: "create issue" }, ctxWith(mgr));
    assert.match(r.output, /already loaded/);
    assert.match(r.output, /don't need this tool/);
  } finally {
    await mgr.dispose();
  }
});

test("a match is loaded and reported by its callable name", async () => {
  const mgr = await poolOf(40);
  try {
    const r = await findMcpTools.execute({ query: "create issue" }, ctxWith(mgr));
    assert.equal(r.isError, undefined);
    assert.match(r.output, /mcp__big__create_issue/, "the name the model must call");
    assert.ok(mgr.snapshot().exposedSchemas().some((s) => s.function.name === "mcp__big__create_issue"));
  } finally {
    await mgr.dispose();
  }
});

test("a miss is honest and tells the model to stop guessing", async () => {
  const mgr = await poolOf(40);
  try {
    const r = await findMcpTools.execute({ query: "kubernetes" }, ctxWith(mgr));
    assert.equal(r.isError, undefined, "a miss is information, not a failure");
    assert.match(r.output, /No MCP tool matches/);
    // The important half: what to do next.
    assert.match(r.output, /solve it another way rather than guessing/);
  } finally {
    await mgr.dispose();
  }
});

test("an empty query is refused rather than matching everything", async () => {
  const r = await findMcpTools.execute({ query: "  " }, ctxWith());
  assert.equal(r.isError, true);
});
