/**
 * discover.test.ts — the probe, driven by a fake server.
 *
 * The whole point of the probe is that we cannot know in advance which MCP a server
 * speaks, and the ecosystem is mid-migration. So the cases are the migration itself: a
 * brand-new server, an old one, one that shares no version with us, and one that is
 * simply broken. Getting the second case wrong is the expensive one — it would drop
 * most servers in existence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "./transport/types.js";
import { UnsupportedProtocolVersionError, acceptLegacyVersion, negotiate, probe, type ProbeRpc } from "./discover.js";

const identity = { name: "mindweave", version: "1.2.0" };

/** A fake server: a map of method → handler, plus a log of what was called. */
function fakeRpc(handlers: Record<string, (params?: Record<string, unknown>) => unknown>): ProbeRpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(method, params) {
      calls.push(method);
      const handler = handlers[method];
      if (!handler) throw new RpcError(-32601, `Method not found: ${method}`);
      return handler(params);
    },
    notify(method) {
      calls.push(`notify:${method}`);
    },
  };
}

test("negotiate takes the NEWEST shared version, not the server's first choice", () => {
  // A server may list in any order. Taking its preference would silently pin us to an
  // old dialect whenever a server happens to list chronologically.
  assert.equal(negotiate(["2024-11-05", "2026-07-28", "2025-11-25"]), "2026-07-28");
  assert.equal(negotiate(["2025-06-18", "2025-11-25"]), "2025-11-25");
});

test("negotiate returns null when nothing overlaps", () => {
  assert.equal(negotiate(["2030-01-01"]), null);
  assert.equal(negotiate([]), null);
});

test("a legacy initialize version is accepted only if we actually know it", () => {
  assert.equal(acceptLegacyVersion("2025-06-18"), "2025-06-18");
  // Guessing here is how a client ends up sending fields a server rejects mid-session.
  assert.equal(acceptLegacyVersion("2019-01-01"), null);
  assert.equal(acceptLegacyVersion(undefined), null);
  assert.equal(acceptLegacyVersion(""), null);
});

test("a 2026-07-28 server is discovered without any handshake", async () => {
  const rpc = fakeRpc({
    "server/discover": () => ({
      protocolVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: {} },
      serverInfo: { name: "acme", version: "3.1.0" },
    }),
  });
  const result = await probe(rpc, identity, {});
  assert.equal(result.version, "2026-07-28");
  assert.equal(result.dialect, "stateless");
  assert.equal(result.legacy, false);
  assert.deepEqual(result.serverInfo, { name: "acme", version: "3.1.0" });
  assert.deepEqual(rpc.calls, ["server/discover"], "no initialize, no initialized notification");
});

test("a pre-stateless server falls back to initialize and is still usable", async () => {
  // The case that covers most servers deployed today. If this path breaks, the client
  // works only against servers that barely exist yet.
  const rpc = fakeRpc({
    initialize: () => ({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "legacy" } }),
  });
  const result = await probe(rpc, identity, {});
  assert.equal(result.version, "2025-06-18");
  assert.equal(result.dialect, "handshake");
  assert.equal(result.legacy, true);
  assert.deepEqual(rpc.calls, ["server/discover", "initialize", "notify:notifications/initialized"]);
});

test("discover is tried FIRST, so the client ages toward the new protocol", async () => {
  const rpc = fakeRpc({
    "server/discover": () => ({ protocolVersions: ["2026-07-28"] }),
    initialize: () => ({ protocolVersion: "2025-06-18" }),
  });
  await probe(rpc, identity, {});
  assert.equal(rpc.calls[0], "server/discover");
  assert.ok(!rpc.calls.includes("initialize"), "a modern server must never be handshaken");
});

test("a server that says method-not-found in PROSE still falls back", async () => {
  const rpc: ProbeRpc & { calls: string[] } = {
    calls: [],
    async request(method) {
      this.calls.push(method);
      if (method === "server/discover") throw new RpcError(-32603, "unknown method 'server/discover'");
      return { protocolVersion: "2024-11-05" };
    },
    notify(method) {
      this.calls.push(`notify:${method}`);
    },
  };
  const result = await probe(rpc, identity, {});
  assert.equal(result.version, "2024-11-05");
  assert.equal(result.legacy, true);
});

test("no shared version is a clear error, not a silent downgrade", async () => {
  const rpc = fakeRpc({ "server/discover": () => ({ protocolVersions: ["2030-01-01"] }) });
  await assert.rejects(() => probe(rpc, identity, {}), UnsupportedProtocolVersionError);
});

test("a version mismatch does NOT trigger the legacy fallback", async () => {
  // Falling back here would handshake a server that already told us it cannot talk to
  // us, and turn a clear diagnosis into a confusing second failure.
  const rpc = fakeRpc({
    "server/discover": () => ({ protocolVersions: ["2030-01-01"] }),
    initialize: () => ({ protocolVersion: "2025-06-18" }),
  });
  await assert.rejects(() => probe(rpc, identity, {}), UnsupportedProtocolVersionError);
  assert.ok(!rpc.calls.includes("initialize"));
});

test("a genuinely broken server propagates its error instead of being mislabelled", async () => {
  const rpc: ProbeRpc = {
    async request() {
      throw new RpcError(-32603, "database is on fire");
    },
    notify() {},
  };
  await assert.rejects(() => probe(rpc, identity, {}), /database is on fire/);
});
