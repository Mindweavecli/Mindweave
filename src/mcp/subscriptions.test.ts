/**
 * subscriptions.test.ts — what we ask a server to tell us, and what we do about it.
 *
 * Both decisions are about cost. Every accepted `toolsListChanged` means re-fetching a
 * catalog and rewriting the tool list mid-session, and a subscription we cannot act on
 * is a held-open stream for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromptsChanged, isResourcesChanged, isToolsChanged, subscriptionsFor, SUBSCRIPTION_TYPES } from "./subscriptions.js";

test("we subscribe to exactly the lists we can act on", () => {
  // All three are actionable since Phase 6: a tool change rebuilds the catalog and
  // re-runs the trust check, a prompt change rebuilds the slash commands, a resource
  // change invalidates a cached listing.
  assert.deepEqual(subscriptionsFor({ tools: {} }), ["toolsListChanged"]);
  assert.deepEqual(subscriptionsFor({ tools: {}, prompts: {}, resources: {} }), [
    "toolsListChanged",
    "promptsListChanged",
    "resourcesListChanged",
  ]);
  // Still NOT this one: per-resource content watching, which nothing consumes.
  assert.ok(SUBSCRIPTION_TYPES.includes("resourceSubscriptions"), "the type exists…");
  assert.ok(!subscriptionsFor({ tools: {}, resources: {} }).includes("resourceSubscriptions"), "…but we do not ask for it");
});

test("a server offering none of it gets no subscription at all", () => {
  // An empty subscription still costs a held-open stream.
  assert.deepEqual(subscriptionsFor({}), []);
  assert.deepEqual(subscriptionsFor({ logging: {} }), []);
});

test("a server saying its list is fixed is believed, per list", () => {
  assert.deepEqual(subscriptionsFor({ tools: { listChanged: false } }), []);
  assert.deepEqual(subscriptionsFor({ tools: { listChanged: true } }), ["toolsListChanged"]);
  // One fixed list must not silence the others.
  assert.deepEqual(subscriptionsFor({ tools: { listChanged: false }, prompts: {} }), ["promptsListChanged"]);
});

test("tool-change notifications are matched across spellings", () => {
  // The method name differs between revisions and implementations. Missing one means a
  // permanently stale catalog; an extra match costs one wasted tools/list.
  assert.equal(isToolsChanged("notifications/tools/list_changed"), true);
  assert.equal(isToolsChanged("toolsListChanged"), true);
  assert.equal(isToolsChanged("notifications/tools/listChanged"), true);
  assert.equal(isToolsChanged("notifications/resources/list_changed"), false);
  assert.equal(isToolsChanged("notifications/progress"), false);
});

test("prompt and resource changes are matched, and kept apart from each other", () => {
  assert.equal(isPromptsChanged("notifications/prompts/list_changed"), true);
  assert.equal(isPromptsChanged("promptsListChanged"), true);
  assert.equal(isPromptsChanged("notifications/tools/list_changed"), false);

  assert.equal(isResourcesChanged("notifications/resources/list_changed"), true);
  assert.equal(isResourcesChanged("resourcesListChanged"), true);
  assert.equal(isResourcesChanged("notifications/prompts/list_changed"), false);
  // A single resource's CONTENT changing is a different event, and we hold no
  // per-resource cache to invalidate — matching it would cause a pointless refetch.
  assert.equal(isResourcesChanged("notifications/resources/updated"), false);
});
