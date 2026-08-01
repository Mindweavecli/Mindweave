/**
 * subscriptions.test.ts — what we ask a server to tell us, and what we do about it.
 *
 * Both decisions are about cost. Every accepted `toolsListChanged` means re-fetching a
 * catalog and rewriting the tool list mid-session, and a subscription we cannot act on
 * is a held-open stream for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolsChanged, subscriptionsFor, SUBSCRIPTION_TYPES } from "./subscriptions.js";

test("we subscribe to tool changes, and only tool changes", () => {
  // Prompts and resources land in Phase 6. Subscribing now would mean accepting
  // notifications with nothing to do about them.
  assert.deepEqual(subscriptionsFor({ tools: {} }), ["toolsListChanged"]);
  assert.ok(SUBSCRIPTION_TYPES.includes("promptsListChanged"), "the type exists…");
  assert.ok(!subscriptionsFor({ tools: {}, prompts: {}, resources: {} }).includes("promptsListChanged"), "…but we do not ask for it");
});

test("a server with no tools gets no subscription at all", () => {
  // An empty subscription still costs a held-open stream.
  assert.deepEqual(subscriptionsFor({}), []);
  assert.deepEqual(subscriptionsFor({ resources: {} }), []);
});

test("a server saying its list is fixed is believed", () => {
  assert.deepEqual(subscriptionsFor({ tools: { listChanged: false } }), []);
  assert.deepEqual(subscriptionsFor({ tools: { listChanged: true } }), ["toolsListChanged"]);
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
