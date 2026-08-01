/**
 * protocol.test.ts — the compatibility rules that decide whether we can talk to a
 * server at all.
 *
 * Every case here is a real interoperability trap rather than a shape check: the
 * missing-`resultType` default, the renumbered error codes, and the shape of the
 * `_meta` envelope are all places where being wrong produces a client that connects,
 * looks fine, and then misreads what the server said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CODES,
  PREFERRED_VERSION,
  SUPPORTED_VERSIONS,
  buildMeta,
  buildRequest,
  cacheDirectiveOf,
  dialectFor,
  errorKind,
  isMethodNotFound,
  isResourceNotFound,
  resultTypeOf,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
} from "./protocol.js";

test("2026-07-28 and later are stateless; everything earlier keeps the handshake", () => {
  assert.equal(dialectFor("2026-07-28"), "stateless");
  assert.equal(dialectFor("2027-01-01"), "stateless", "a future revision must not fall back to the handshake");
  assert.equal(dialectFor("2025-11-25"), "handshake");
  assert.equal(dialectFor("2024-11-05"), "handshake");
});

test("the preferred version is one we actually claim to support", () => {
  assert.ok(SUPPORTED_VERSIONS.includes(PREFERRED_VERSION));
});

test("a result with no resultType is COMPLETE, not pending", () => {
  // The spec's compatibility rule. Backwards, every legacy result would look like an
  // unfinished multi-round-trip request and the client would wait forever.
  assert.equal(resultTypeOf({}), "complete");
  assert.equal(resultTypeOf({ content: [] }), "complete");
  assert.equal(resultTypeOf(null), "complete");
  assert.equal(resultTypeOf({ resultType: "complete" }), "complete");
  assert.equal(resultTypeOf({ resultType: "input_required" }), "input_required");
});

test("_meta rides on stateless requests and is absent on handshake ones", () => {
  const identity = { name: "mindweave", version: "1.2.0" };
  const meta = buildMeta("stateless", "2026-07-28", identity);
  assert.ok(meta);
  assert.equal(meta[META_PROTOCOL_VERSION], "2026-07-28");
  assert.deepEqual(meta[META_CLIENT_INFO], identity);
  // On the old dialect this information travelled once, in `initialize`. Sending it
  // per-request would be an unknown field to a server that predates it.
  assert.equal(buildMeta("handshake", "2025-11-25", identity), undefined);
});

test("buildRequest folds _meta inside params, and omits params when there are none", () => {
  const meta = buildMeta("stateless", "2026-07-28", { name: "mindweave", version: "1.2.0" })!;
  const withArgs = buildRequest(1, "tools/call", { name: "x" }, meta);
  assert.equal((withArgs.params as Record<string, unknown>).name, "x");
  assert.ok((withArgs.params as Record<string, unknown>)._meta, "_meta belongs inside params");

  const bare = buildRequest(2, "tools/list", undefined, meta);
  assert.ok(bare.params?._meta, "a param-less request still carries the envelope");

  const legacy = buildRequest(3, "tools/list", undefined, undefined);
  assert.equal(legacy.params, undefined, "handshake dialect sends no params object at all");
});

test("both the new and the pre-renumbering MCP error codes are recognised", () => {
  // 2026-07-28 moved these out of the implementation-defined range. Servers on either
  // side of the change are live right now, so both values have to classify.
  assert.equal(errorKind(ERROR_CODES.unsupportedProtocolVersion), "unsupported-version");
  assert.equal(errorKind(-32004), "unsupported-version", "pre-renumbering value");
  assert.equal(errorKind(ERROR_CODES.headerMismatch), "header-mismatch");
  assert.equal(errorKind(-32001), "header-mismatch", "pre-renumbering value");
  assert.equal(errorKind(ERROR_CODES.missingRequiredClientCapability), "missing-capability");
  assert.equal(errorKind(-32003), "missing-capability", "pre-renumbering value");
  assert.equal(errorKind(12345), "unknown");
});

test("resource-not-found is accepted at both its old and new codes", () => {
  assert.equal(isResourceNotFound(-32602), true, "new: JSON-RPC invalid params");
  assert.equal(isResourceNotFound(-32002), true, "old: MCP-specific code");
  assert.equal(isResourceNotFound(-32601), false);
});

test("method-not-found is detected by code OR by message", () => {
  // This is the backwards-compatibility signal for `server/discover`. Servers are
  // inconsistent about how they say it, and missing one reads a legacy server as
  // broken and drops it from the session.
  assert.equal(isMethodNotFound(ERROR_CODES.methodNotFound), true);
  assert.equal(isMethodNotFound(-32603, "Method not found: server/discover"), true);
  assert.equal(isMethodNotFound(-32603, "unknown method"), true);
  assert.equal(isMethodNotFound(-32603, "database is on fire"), false);
});

test("cache directives are read when valid and ignored when not", () => {
  assert.deepEqual(cacheDirectiveOf({ ttlMs: 60_000, cacheScope: "public" }), { ttlMs: 60_000, cacheScope: "public" });
  assert.deepEqual(cacheDirectiveOf({ ttlMs: -5, cacheScope: "sideways" }), {}, "nonsense is dropped, not trusted");
  assert.deepEqual(cacheDirectiveOf(null), {});
});
