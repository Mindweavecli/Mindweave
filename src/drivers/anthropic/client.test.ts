/**
 * client.test.ts — the Anthropic format translation.
 *
 * This driver's whole job is converting between the stored transcript and a wire
 * format that disagrees with it in several places, so these tests drive that
 * conversion directly with hand-built transcripts. No network, no API key.
 *
 * The case that matters most is parallel tool results: the transcript records them
 * as consecutive `role: "tool"` entries, and Anthropic requires them in a SINGLE
 * user message. Getting that wrong doesn't error — it quietly teaches the model to
 * stop making parallel tool calls — so it is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { buildBody, emit, renderMessages, toStop, toTurn, toUsage } from "./client.js";
import { OPUS, SONNET, normalize, thinkLevels } from "./manifest.js";
import type { ModelRequest, StreamEvent } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };

/** Content blocks of a message, as an array (they always are here). */
function blocks(msg: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  assert.ok(Array.isArray(msg.content), "expected block array content");
  return msg.content;
}

// ── Message conversion ────────────────────────────────────────────────────────

test("the system prompt goes top-level, never into the conversation", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "hi" }] }, 1000);
  assert.ok(Array.isArray(body.system));
  assert.equal((body.system as Anthropic.TextBlockParam[])[0]!.text, "SYSTEM");
  assert.ok(
    body.messages.every((m) => m.role !== ("system" as unknown)),
    "no message may carry the system role",
  );
});

test("a stray in-conversation system message is folded into the system prompt, not dropped", () => {
  const body = buildBody(
    {
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "EXTRA RULE" },
      ],
    },
    1000,
  );
  const system = (body.system as Anthropic.TextBlockParam[])[0]!.text;
  assert.match(system, /SYSTEM/);
  assert.match(system, /EXTRA RULE/);
});

test("PARALLEL tool results collapse into ONE user message", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "do both" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read", arguments: '{"p":"x"}' } },
          { id: "b", type: "function", function: { name: "read", arguments: '{"p":"y"}' } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "AAA" },
      { role: "tool", tool_call_id: "b", content: "BBB" },
    ],
  });

  // user → assistant → ONE user carrying both results.
  assert.equal(messages.length, 3);
  assert.equal(messages[2]!.role, "user");
  const results = blocks(messages[2]!);
  assert.equal(results.length, 2, "both tool results belong in the same user message");
  assert.deepEqual(
    results.map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id),
    ["a", "b"],
  );
});

test("separate tool rounds stay in separate user messages", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "AAA" },
      { role: "assistant", content: "", tool_calls: [{ id: "b", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "b", content: "BBB" },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
});

test("assistant tool calls become tool_use blocks with PARSED object input", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [{ id: "t1", type: "function", function: { name: "edit", arguments: '{"path":"a.ts","n":3}' } }],
      },
    ],
  });
  const parts = blocks(messages[1]!);
  assert.equal(parts[0]!.type, "text");
  const call = parts[1] as Anthropic.ToolUseBlockParam;
  assert.equal(call.type, "tool_use");
  assert.equal(call.id, "t1");
  assert.equal(call.name, "edit");
  // An object, not the JSON string the transcript stores.
  assert.deepEqual(call.input, { path: "a.ts", n: 3 });
});

test("malformed tool arguments degrade to {} rather than failing the turn", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{not json" } }] },
    ],
  });
  assert.deepEqual((blocks(messages[1]!)[0] as Anthropic.ToolUseBlockParam).input, {});
});

test("empty assistant prose produces no empty text block", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "   ", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{}" } }] },
    ],
  });
  const parts = blocks(messages[1]!);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, "tool_use");
});

test("an empty conversation still produces a valid request", () => {
  const body = buildBody(base, 1000);
  assert.ok(body.messages.length > 0, "Anthropic rejects an empty messages array");
  assert.equal(body.messages[0]!.role, "user");
});

// ── Caching ───────────────────────────────────────────────────────────────────

test("volatile context is appended AFTER the cache breakpoint, never inside it", () => {
  const withCtx = buildBody({ ...base, messages: [{ role: "user", content: "hi" }], context: "MAP v1" }, 1000);
  const last = withCtx.messages[withCtx.messages.length - 1]!;
  const lastBlock = blocks(last)[0] as Anthropic.TextBlockParam;
  assert.match(lastBlock.text, /MAP v1/);
  assert.equal(lastBlock.cache_control, undefined, "the volatile tail must not be a breakpoint");
});

test("the cacheable prefix is byte-identical when only the volatile context changes", () => {
  const msgs = [{ role: "user" as const, content: "build the cart" }];
  const a = buildBody({ ...base, messages: msgs, context: "MAP v1" }, 1000);
  const b = buildBody({ ...base, messages: msgs, context: "MAP v2" }, 1000);
  assert.deepEqual(a.system, b.system);
  assert.deepEqual(a.messages.slice(0, -1), b.messages.slice(0, -1));
});

test("breakpoints mark the system prompt and the last stable message, and stay under the limit of 4", () => {
  const body = buildBody(
    {
      ...base,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
      context: "volatile",
    },
    1000,
  );
  const system = body.system as Anthropic.TextBlockParam[];
  assert.deepEqual(system[system.length - 1]!.cache_control, { type: "ephemeral" });

  // The last STABLE message (the assistant turn), not the appended context.
  const stable = blocks(body.messages[body.messages.length - 2]!);
  assert.deepEqual(
    (stable[stable.length - 1] as Anthropic.TextBlockParam).cache_control,
    { type: "ephemeral" },
  );

  const count = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.ok(count <= 4, `Anthropic allows at most 4 breakpoints, found ${count}`);
});

// ── Request options ───────────────────────────────────────────────────────────

test("tools convert from the stored OpenAI shape to input_schema", () => {
  const body = buildBody(
    {
      ...base,
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } } }],
    },
    1000,
  );
  assert.equal(body.tools?.length, 1);
  const tool = body.tools![0] as Anthropic.Tool;
  assert.equal(tool.name, "read");
  assert.equal(tool.description, "Read a file");
  assert.deepEqual(tool.input_schema, { type: "object", properties: {} });
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("no tools means no tool_choice (a plain-text answer is forced)", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "go" }] }, 1000);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("reasoning maps to adaptive thinking plus an effort level, never a token budget", () => {
  const on = buildBody({ ...base, messages: [{ role: "user", content: "x" }], model: { model: OPUS, thinking: true, effort: "max" } }, 1000);
  assert.deepEqual(on.thinking, { type: "adaptive" });
  assert.deepEqual(on.output_config, { effort: "max" });

  const off = buildBody({ ...base, messages: [{ role: "user", content: "x" }], model: { model: OPUS, thinking: false, effort: "high" } }, 1000);
  assert.deepEqual(off.thinking, { type: "disabled" });

  // These models reject both of these outright; neither may ever be sent.
  const serialized = JSON.stringify(on) + JSON.stringify(off);
  assert.ok(!serialized.includes("budget_tokens"), "budget_tokens is rejected by these models");
  for (const param of ["temperature", "top_p", "top_k"]) {
    assert.ok(!serialized.includes(`"${param}"`), `${param} is rejected by these models`);
  }
});

// ── Model rules ───────────────────────────────────────────────────────────────

test("normalize never pairs disabled thinking with an effort Opus 5 rejects", () => {
  for (const model of [OPUS, SONNET]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const config = normalize({ model, thinking: false, effort });
      assert.ok(
        config.effort !== "xhigh" && config.effort !== "max",
        `${model}: no-thinking at ${effort} must step down, got ${config.effort}`,
      );
    }
  }
});

test("normalize keeps every advertised reasoning level intact", () => {
  for (const model of [OPUS, SONNET]) {
    for (const level of thinkLevels(model)) {
      const config = { model, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(normalize(config), config, `${model}: "${level.label}" was altered`);
    }
  }
});

// ── Response conversion ───────────────────────────────────────────────────────

test("toTurn joins text, converts tool_use back to a JSON string, and drops thinking", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "Here " },
      { type: "text", text: "you go." },
      { type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } },
    ],
  } as unknown as Anthropic.Message;

  const turn = toTurn(message);
  assert.equal(turn.content, "Here you go.");
  assert.ok(!turn.content.includes("internal reasoning"), "thinking must never reach the transcript");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]!.name, "edit");
  assert.equal(turn.toolCalls[0]!.arguments, '{"path":"a.ts"}');
  assert.deepEqual(JSON.parse(turn.toolCalls[0]!.arguments), { path: "a.ts" });
});

test("usage counts the FULL prompt, not just the uncached remainder", () => {
  // Anthropic's input_tokens excludes both cache figures; summing is the only way
  // to get real context occupancy.
  const usage = toUsage({
    input_tokens: 100,
    output_tokens: 40,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 700,
  } as Anthropic.Usage)!;

  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.totalTokens, 1040);
  assert.equal(usage.cacheHitTokens, 700);
  // Cache writes are billed as fresh input, so they count on the miss side.
  assert.equal(usage.cacheMissTokens, 300);
  assert.equal(usage.cacheHitTokens + usage.cacheMissTokens, usage.promptTokens);
});

test("usage tolerates a response that reports no cache figures", () => {
  const usage = toUsage({ input_tokens: 50, output_tokens: 10 } as Anthropic.Usage)!;
  assert.equal(usage.promptTokens, 50);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 50);
  assert.equal(toUsage(undefined), undefined);
});

// ── Streaming ─────────────────────────────────────────────────────────────────

/** Collect the events `emit` produces for a sequence of raw stream events. */
function collect(raw: unknown[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const event of raw) emit(event as Anthropic.MessageStreamEvent, (e) => out.push(e));
  return out;
}

test("streaming maps text, thinking, and tool-call deltas onto the shared events", () => {
  const events = collect([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "edit", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"p"' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"a"}' } },
    { type: "message_stop" },
  ]);

  assert.deepEqual(events, [
    { type: "reasoning", delta: "hmm" },
    { type: "text", delta: "Hello" },
    { type: "tool_start", index: 2, id: "t1", name: "edit" },
    { type: "tool_args", index: 2, delta: '{"p"' },
    { type: "tool_args", index: 2, delta: ':"a"}' },
  ]);
});

test("streaming ignores events it has no shared equivalent for", () => {
  assert.deepEqual(
    collect([
      { type: "message_start", message: {} },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ]),
    [],
  );
});

// ── Stop reasons ──────────────────────────────────────────────────────────────

test("stop reasons map onto the shared set, so a truncated reply is detectable", () => {
  assert.equal(toStop("end_turn"), "end");
  assert.equal(toStop("tool_use"), "end");
  assert.equal(toStop("max_tokens"), "truncated");
  assert.equal(toStop("refusal"), "refused");
  assert.equal(toStop("model_context_window_exceeded"), "overflow");
  // An unfamiliar or absent reason must not be reported as a failure.
  assert.equal(toStop(null), "end");
  assert.equal(toStop("something_new" as never), "end");
});

test("toTurn carries the stop reason through", () => {
  const truncated = { content: [{ type: "text", text: "half an ans" }], stop_reason: "max_tokens" } as unknown as Anthropic.Message;
  assert.equal(toTurn(truncated).stop, "truncated");
  const normal = { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
  assert.equal(toTurn(normal).stop, "end");
});
