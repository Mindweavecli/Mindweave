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
 * Only `toolsListChanged`, and only when the server actually advertises tools. Prompts
 * and resources arrive in Phase 6 and subscribing to them now would mean accepting
 * notifications with nothing to do about them. A server with no tools gets no
 * subscription at all rather than an empty one, because an empty `subscriptions/listen`
 * still costs a held-open stream.
 */
export function subscriptionsFor(capabilities: Record<string, unknown>): SubscriptionType[] {
  const tools = capabilities?.tools as { listChanged?: unknown } | undefined;
  if (!tools) return [];
  // `listChanged: false` is a server saying its list is fixed. Believe it.
  if (tools.listChanged === false) return [];
  return ["toolsListChanged"];
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
  const m = method.toLowerCase();
  return m.includes("tool") && (m.includes("list_changed") || m.includes("listchanged"));
}
