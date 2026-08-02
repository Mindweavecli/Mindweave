/**
 * prompts.test.ts — server-authored commands.
 *
 * The pure half is mostly about the argument mapping, because that is where a slash
 * command quietly loses data: a naive split hands the server the first word and drops
 * the rest, and nobody notices because the prompt still runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasPrompts,
  mapPromptArguments,
  parsePromptCommand,
  parsePromptList,
  promptCommand,
  promptUsage,
  renderPromptMessages,
  type McpPrompt,
} from "./prompts.js";
import { McpManager } from "./manager.js";
import type { McpServerConfig } from "./config.js";

const review: McpPrompt = {
  server: "github",
  name: "review",
  description: "Review a pull request",
  arguments: [
    { name: "pr", description: "PR number", required: true },
    { name: "focus", description: "What to emphasise", required: false },
  ],
};

test("a prompt is named as something a person can type", () => {
  assert.equal(promptCommand(review), "/github:review");
  assert.deepEqual(parsePromptCommand("/github:review"), { server: "github", name: "review" });
  assert.equal(parsePromptCommand("/skills"), null, "an ordinary command is not a prompt");
  assert.equal(parsePromptCommand("/a:b:c"), null, "and neither is something ambiguous");
});

test("prompts that could not be typed as a command are dropped", () => {
  const parsed = parsePromptList("srv", {
    prompts: [
      { name: "ok", description: "fine" },
      { name: "has space" },
      { name: "has:colon" },
      { name: "dup" },
      { name: "dup" },
      { name: "" },
    ],
  });
  assert.deepEqual(parsed.map((p) => p.name), ["dup", "ok"]);
});

test("declared arguments survive the parse, including whether they are required", () => {
  const [p] = parsePromptList("srv", {
    prompts: [{ name: "x", arguments: [{ name: "a", required: true }, { name: "b" }, { description: "nameless" }] }],
  });
  assert.deepEqual(p!.arguments, [
    { name: "a", description: "", required: true },
    { name: "b", description: "", required: false },
  ]);
});

test("the LAST argument soaks up the rest of the line", () => {
  // The bug this prevents: `/github:review 123 be harsh about the tests` silently sending
  // focus="be" and throwing four words away.
  const { values, missing } = mapPromptArguments(review, ["123", "be", "harsh", "about", "tests"]);
  assert.deepEqual(values, { pr: "123", focus: "be harsh about tests" });
  assert.deepEqual(missing, []);
});

test("a missing required argument is reported, not silently sent empty", () => {
  const { missing } = mapPromptArguments(review, []);
  assert.deepEqual(missing, ["pr"]);
  assert.match(promptUsage(review), /Usage: \/github:review <pr> \[focus\]/);
  assert.match(promptUsage(review), /pr — PR number/);
});

test("an optional argument left out is simply absent", () => {
  const { values, missing } = mapPromptArguments(review, ["42"]);
  assert.deepEqual(values, { pr: "42" });
  assert.deepEqual(missing, []);
});

test("a rendered prompt is the text of one user turn", () => {
  assert.equal(renderPromptMessages({ messages: [{ role: "user", content: { type: "text", text: "do it" } }] }), "do it");
  // Several messages keep their roles as labels rather than being forged into real
  // assistant turns the model never produced.
  const multi = renderPromptMessages({
    messages: [
      { role: "user", content: { type: "text", text: "context" } },
      { role: "assistant", content: [{ type: "text", text: "understood" }] },
    ],
  });
  assert.equal(multi, "[user]\ncontext\n\n[assistant]\nunderstood");
  assert.equal(renderPromptMessages({}), "", "nothing to run is not an empty turn");
});

test("a server without a prompts capability is not asked", () => {
  assert.equal(hasPrompts({}), false);
  assert.equal(hasPrompts({ prompts: {} }), true);
});

/** A server offering one prompt that echoes the arguments it was given. */
const PROMPT_SERVER = [
  'let buf = "";',
  'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => {',
  "  buf += c;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.id === undefined) continue;",
  '    if (msg.method === "server/discover") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: { tools: {}, prompts: {} } } }); continue; }',
  '    if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }); continue; }',
  '    if (msg.method === "prompts/list") { send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [{ name: "review", description: "Review a PR", arguments: [{ name: "pr", required: true }] }] } }); continue; }',
  '    if (msg.method === "prompts/get") { send({ jsonrpc: "2.0", id: msg.id, result: { messages: [{ role: "user", content: { type: "text", text: "Review PR " + msg.params.arguments.pr } }] } }); continue; }',
  '    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });',
  "  }",
  "});",
].join("\n");

const cfg: McpServerConfig = { type: "stdio", name: "gh", command: process.execPath, args: ["-e", PROMPT_SERVER] };

test("a server's prompts arrive as commands and render into a turn", async () => {
  const mgr = new McpManager();
  await mgr.start([cfg]);
  try {
    // Fetched at connect: the completion menu is rendered on a keystroke and cannot wait
    // for a round trip.
    const catalog = mgr.promptCatalog();
    assert.equal(catalog.length, 1);
    assert.equal(promptCommand(catalog[0]!), "/gh:review");
    assert.ok(mgr.findPrompt("gh", "review"));
    assert.equal(mgr.findPrompt("gh", "nope"), undefined);

    const rendered = await mgr.renderPrompt("gh", "review", { pr: "77" });
    assert.equal(rendered.error, undefined);
    assert.equal(rendered.text, "Review PR 77");
  } finally {
    await mgr.dispose();
  }
});

test("a prompt on a server that is not there fails with a sentence, not a throw", async () => {
  const mgr = new McpManager();
  await mgr.start([cfg]);
  try {
    const rendered = await mgr.renderPrompt("nosuch", "review", {});
    assert.match(rendered.error ?? "", /not connected/);
    assert.equal(rendered.text, "");
  } finally {
    await mgr.dispose();
  }
});
