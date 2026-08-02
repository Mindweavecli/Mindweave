/**
 * subscriptions.ts — staying current with a server that changes underneath us.
 *
 * A server's tool list is not fixed. It can gain tools when a user authenticates, lose
 * them when a backend goes away, or change entirely on a redeploy. Before 2026-07-28 a
 * client learned about that through `resources/subscribe` and an always-on GET channel;
 * both are gone. In their place is `subscriptions/listen`: ONE long-lived stream that
 * the client opts into by naming the change types it cares about.
 *
 * Opting in is the whole design point. A client that subscribes to everything pays for
 * traffic it will ignore, and — more to the point here — every `toolsListChanged` we
 * accept means re-fetching a catalog and rewriting the tool list mid-session, which
 * costs a prompt-cache prefix. So we ask for exactly what we can act on today.
 *
 * The decisions are pure so the policy is testable without a server; `connection.ts`
 * owns the plumbing.
 */

/** Change types the 2026-07-28 spec defines for `subscriptions/listen`. */
export const SUBSCRIPTION_TYPES = ["toolsListChanged", "promptsListChanged", "resourcesListChanged", "resourceSubscriptions"] as const;
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];

/** The notification a server sends when its tool list moved. */
export const TOOLS_CHANGED = "notifications/tools/list_changed";

/**
 * Which change types to request from a server (pure).
 *
 * Only what we can act on, and only where the server says the list can move. All three
 * are actionable now: a changed tool list rebuilds the catalog (and re-runs the trust
 * check), a changed prompt list rebuilds the slash commands, and a changed resource list
 * invalidates a cached listing. `resourceSubscriptions` is still not requested — that is
 * per-resource content watching, which nothing in the agent consumes.
 *
 * A server that advertises none of them gets no subscription at all rather than an empty
 * one, because an empty `subscriptions/listen` still costs a held-open stream.
 */
export function subscriptionsFor(capabilities: Record<string, unknown>): SubscriptionType[] {
  const wanted: SubscriptionType[] = [];
  // `listChanged: false` is a server saying its list is fixed. Believe it.
  const declares = (key: string): boolean => {
    const cap = capabilities?.[key] as { listChanged?: unknown } | undefined;
    return Boolean(cap) && cap!.listChanged !== false;
  };
  if (declares("tools")) wanted.push("toolsListChanged");
  if (declares("prompts")) wanted.push("promptsListChanged");
  if (declares("resources")) wanted.push("resourcesListChanged");
  return wanted;
}

/**
 * Does this notification mean "your tool catalog is stale" (pure)?
 *
 * Matched loosely on purpose. The method name is spelled slightly differently across
 * revisions and implementations (`notifications/tools/list_changed` vs
 * `toolsListChanged`), and the cost of missing one is a permanently stale catalog,
 * while the cost of an extra match is one wasted `tools/list`.
 */
export function isToolsChanged(method: string): boolean {
  return isListChanged(method, "tool");
}

/** Does this notification mean "your prompt list is stale" (pure)? */
export function isPromptsChanged(method: string): boolean {
  return isListChanged(method, "prompt");
}

/** Does this notification mean "your resource list is stale" (pure)? */
export function isResourcesChanged(method: string): boolean {
  // `resources/updated` is a different thing — one resource's CONTENT changed — and we
  // hold no per-resource cache to invalidate, so it is deliberately not matched here.
  return isListChanged(method, "resource");
}

function isListChanged(method: string, subject: string): boolean {
  const m = method.toLowerCase();
  return m.includes(subject) && (m.includes("list_changed") || m.includes("listchanged"));
}
