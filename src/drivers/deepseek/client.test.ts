/**
 * client.test.ts — the streaming SSE reader (consumeStream).
 *
 * Drives the parser with hand-built SSE byte streams, including frames split
 * across "network packets", so we know a fragmented tool call or a payload cut
 * mid-line is still assembled correctly. No network, no API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, consumeStream, renderMessages, toStop } from "./client.js";
import { FLASH, PRO, normalize, thinkLevels } from "./manifest.js";
import type { ModelRequest, StreamEvent } from "../types.js";

// ── renderMessages: the cache-friendly request shape (universal) ───────────────
test("renderMessages keeps a stable prefix and puts volatile context at the tail", () => {
  const base: ModelRequest = {
    system: "STABLE SYSTEM",
    messages: [
      { role: "user", content: "build the cart" },
      { role: "assistant", content: "on it" },
    ],
  };
  const a = renderMessages({ ...base, context: "map v1 / todo A" });
  const b = renderMessages({ ...base, context: "map v2 / todo B" });

  // System is first; the volatile context is the last message.
  assert.equal(a[0]!.role, "system");
  assert.equal(a[0]!.content, "STABLE SYSTEM");
  assert.match(a[a.length - 1]!.content, /map v1 \/ todo A/);

  // The cacheable prefix (everything before the trailing context) is byte-identical
  // even though the context changed — this is what the provider serves from cache.
  assert.deepEqual(a.slice(0, -1), b.slice(0, -1));
});

test("renderMessages omits an empty/whitespace context (no trailing block)", () => {
  const msgs = renderMessages({ system: "S", messages: [{ role: "user", content: "hi" }], context: "   " });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[msgs.length - 1]!.role, "user");
});

/** A fake Response whose body yields the given pieces as separate UTF-8 packets. */
function bodyOf(pieces: string[]): Pick<Response, "body"> {
  const encoder = new TextEncoder();
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (const p of pieces) yield encoder.encode(p);
  }
  return { body: gen() } as unknown as Pick<Response, "body">;
}

/** Wrap a chunk object as one SSE frame. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test("streams plain text: content accumulates, text events fire in order", async () => {
  const events: StreamEvent[] = [];
  const result = await consumeStream(
    bodyOf([
      frame({ choices: [{ delta: { content: "Hel" } }] }),
      frame({ choices: [{ delta: { content: "lo" } }] }),
      "data: [DONE]\n\n",
    ]),
    (e) => events.push(e),
  );
  assert.equal(result.content, "Hello");
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta),
    ["Hel", "lo"],
  );
});

test("reasoning_content emits reasoning events and never leaks into content", async () => {
  const events: StreamEvent[] = [];
  const result = await consumeStream(
    bodyOf([
      frame({ choices: [{ delta: { reasoning_content: "thinking…" } }] }),
      frame({ choices: [{ delta: { content: "answer" } }] }),
    ]),
    (e) => events.push(e),
  );
  assert.equal(result.content, "answer");
  assert.deepEqual(
    events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta),
    ["thinking…"],
  );
});

test("fragmented tool call: name first, args across chunks, one tool_start", async () => {
  const events: StreamEvent[] = [];
  const result = await consumeStream(
    bodyOf([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "grep" } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] } }] }),
    ]),
    (e) => events.push(e),
  );
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "grep", arguments: '{"pattern":"x"}' }]);
  const starts = events.filter((e) => e.type === "tool_start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], { type: "tool_start", index: 0, id: "c1", name: "grep" });
});

test("two parallel tool calls accumulate independently, ordered by index", async () => {
  const result = await consumeStream(
    bodyOf([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "{}" } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "grep", arguments: "{}" } }] } }] }),
    ]),
  );
  assert.deepEqual(result.toolCalls.map((t) => t.name), ["read", "grep"]);
});

test("a frame split across packet boundaries is still parsed", async () => {
  const whole = frame({ choices: [{ delta: { content: "split" } }] });
  const cut = Math.floor(whole.length / 2);
  const result = await consumeStream(bodyOf([whole.slice(0, cut), whole.slice(cut)]));
  assert.equal(result.content, "split");
});

test("usage from the trailing chunk is captured", async () => {
  const result = await consumeStream(
    bodyOf([
      frame({ choices: [{ delta: { content: "hi" } }] }),
      frame({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3 },
      }),
    ]),
  );
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cacheHitTokens: 7,
    cacheMissTokens: 3,
  });
});

test("malformed and keep-alive lines are ignored", async () => {
  const result = await consumeStream(
    bodyOf([
      ": keep-alive comment\n\n",
      "data: not-json\n\n",
      frame({ choices: [{ delta: { content: "ok" } }] }),
    ]),
  );
  assert.equal(result.content, "ok");
});

test("stop reasons map onto the shared set, so a truncated reply is detectable", () => {
  assert.equal(toStop("stop"), "end");
  assert.equal(toStop("tool_calls"), "end");
  assert.equal(toStop("length"), "truncated");
  assert.equal(toStop("content_filter"), "refused");
  // DeepSeek-specific: infrastructure cut the request off, not a token limit or a
  // safety decision. Must not silently read as a clean finish.
  assert.equal(toStop("insufficient_system_resource"), "overloaded");
  // An unfamiliar or absent reason must not be reported as a failure.
  assert.equal(toStop(undefined), "end");
  assert.equal(toStop("something_new"), "end");
});

// ── thinking: ALWAYS sent explicitly, never omitted ────────────────────────────
//
// DeepSeek's own docs say omitting the `thinking` field defaults to ENABLED at
// high effort — not disabled. Every request must say one or the other.

const withMessages: ModelRequest = { system: "S", messages: [{ role: "user", content: "hi" }] };

test("thinking on sends the enabled type plus the effort budget", () => {
  const body = buildBody({ ...withMessages, model: { model: PRO, thinking: true, effort: "max" } });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
});

test("thinking off sends an EXPLICIT disabled type, never an omitted field", () => {
  const body = buildBody({ ...withMessages, model: { model: "deepseek-v4-flash", thinking: false, effort: "high" } });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("no model config at all (the internal summarizer/distiller calls) still disables thinking explicitly", () => {
  // These calls never set req.model. Before the fix this meant the whole
  // `thinking` field was omitted, which DeepSeek's API reads as "enabled" — so an
  // internal call meant to be cheap was silently paying for full reasoning nobody
  // asked for and nothing ever displayed.
  const body = buildBody(withMessages);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

// ── reasoning_effort must be a value DeepSeek actually accepts ────────────────
//
// The shared Effort type is the union of every provider's ladder, so it contains
// rungs DeepSeek has never had (`medium`, `xhigh` are Anthropic's). Sending one is
// not a soft failure — the API does not recognize the value. Pro's "Maximum" once
// sent `xhigh` for exactly this reason and silently did nothing.

/** Exactly what DeepSeek's API reference documents for `reasoning_effort`. */
const ACCEPTED = new Set(["low", "high", "max"]);

test("every advertised /think level puts an ACCEPTED effort on the wire", () => {
  for (const model of [FLASH, PRO]) {
    for (const level of thinkLevels(model)) {
      const body = buildBody({
        ...withMessages,
        model: { model, thinking: level.thinking, effort: level.effort },
      });
      if (!level.thinking) {
        assert.equal(body.reasoning_effort, undefined, `${model}/${level.label}: no effort without thinking`);
        continue;
      }
      assert.ok(
        ACCEPTED.has(String(body.reasoning_effort)),
        `${model}/${level.label} sends reasoning_effort="${body.reasoning_effort}", which DeepSeek does not accept`,
      );
    }
  }
});

test("Pro's Maximum sends max, not another provider's xhigh", () => {
  const max = thinkLevels(PRO).find((l) => l.label === "Maximum")!;
  assert.equal(max.effort, "max");
});

test("normalize clamps any foreign or stale effort to something accepted", () => {
  // "xhigh" is what older builds persisted to model.json; "medium" is Anthropic's.
  for (const stale of ["xhigh", "medium", "minimal", "nonsense"] as const) {
    const out = normalize({ model: PRO, thinking: true, effort: stale as never });
    assert.ok(ACCEPTED.has(out.effort), `effort "${stale}" normalized to "${out.effort}"`);
  }
});

test("Flash has no maximum tier, so max steps down there", () => {
  assert.equal(normalize({ model: FLASH, thinking: true, effort: "max" }).effort, "high");
  assert.equal(normalize({ model: PRO, thinking: true, effort: "max" }).effort, "max");
});
