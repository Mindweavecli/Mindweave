/**
 * connection.ts — one MCP server, and what state it is in.
 *
 * The previous implementation had no notion of state: a server was in a map or it was
 * not. That makes three ordinary situations indistinguishable — still starting, failed
 * to start, and waiting on the user to authenticate — so nothing could report anything
 * useful and a dead server stayed dead for the session.
 *
 * So a connection is a small state machine:
 *
 *   pending ──► connected ──► (dies) ──► pending ──► …
 *      │                                    │
 *      ├──► failed          (cap reached) ◄─┘
 *      └──► needs-auth
 *
 * `needs-auth` is deliberately separate from `failed`. A 401 is not a broken server, it
 * is a server waiting on the user, and collapsing the two would make the eventual auth
 * flow look like an outage.
 *
 * Reconnection is capped at 3 consecutive failures, the same number used by the
 * repeat-failure breaker in the engine. Past the cap we STOP and surface the state
 * rather than retrying forever: a server that cannot start will not start on the
 * fourth try, and quietly burning attempts is how a session ends up slow for a reason
 * the user cannot see. `/mcp` can always retry by hand.
 */
import { appVersion } from "../cli/version.js";
import { parseToolList, type McpToolDef } from "./catalog.js";
import type { McpServerConfig } from "./config.js";
import { probe, UnsupportedProtocolVersionError, type Negotiated } from "./discover.js";
import { buildMeta, DEFAULT_CLIENT_CAPABILITIES, cacheDirectiveOf, type CacheDirective } from "./protocol.js";
import { HttpTransport } from "./transport/http.js";
import { StdioTransport } from "./transport/stdio.js";
import { RpcError, type Transport } from "./transport/types.js";
import { isToolsChanged, subscriptionsFor } from "./subscriptions.js";

/** Consecutive failed connect attempts before we stop trying on our own. */
export const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Backoff between automatic reconnects, in ms.
 *
 * Deliberately short and deliberately finite. A server that dies mid-session is usually
 * a crash or a restart, and getting it back within a few seconds is the difference
 * between a blip and losing its tools for the rest of the session. But retrying forever
 * is the pattern the repeat-failure breaker exists to prevent: a server that will not
 * come back does not come back on the tenth attempt either, and quietly burning them is
 * how a session gets slow for a reason the user cannot see. After the last one we stop
 * and say so; `/mcp` can always retry by hand.
 */
export const RECONNECT_BACKOFF_MS = [1_000, 4_000, 10_000];

export type ConnectionState = "pending" | "connected" | "failed" | "needs-auth" | "disabled";

/** Everything the UI and the pool need to know about one server. */
export interface ConnectionStatus {
  name: string;
  state: ConnectionState;
  toolCount: number;
  /** Why it is failed, when it is. */
  error?: string;
  /** Negotiated protocol revision, once connected. */
  version?: string;
  /** True when we reached the server through the legacy `initialize` path. */
  legacy?: boolean;
  serverInfo?: { name: string; version?: string };
  attempts: number;
}

/** Is this error the server telling us it wants credentials? */
export function isAuthError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "number" && e.code === -32001) return true;
  return typeof e?.message === "string" && /\b401\b|\b403\b|unauthor|forbidden/i.test(e.message);
}

export class McpConnection {
  private transport: Transport | null = null;
  private negotiated: Negotiated | null = null;
  private toolDefs: McpToolDef[] = [];
  private cache: CacheDirective = {};
  private toolsFetchedAt = 0;
  private state: ConnectionState;
  private lastError = "";
  private attempts = 0;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private onChange: (() => void) | null = null;

  constructor(readonly config: McpServerConfig) {
    this.state = config.disabled ? "disabled" : "pending";
  }

  /** Told whenever this server's state or catalog moves, so the UI can repaint. */
  setOnChange(handler: (() => void) | null): void {
    this.onChange = handler;
  }

  private changed(): void {
    this.onChange?.();
  }

  status(): ConnectionStatus {
    return {
      name: this.config.name,
      state: this.state,
      toolCount: this.toolDefs.length,
      attempts: this.attempts,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.negotiated ? { version: this.negotiated.version, legacy: this.negotiated.legacy } : {}),
      ...(this.negotiated?.serverInfo ? { serverInfo: this.negotiated.serverInfo } : {}),
    };
  }

  tools(): readonly McpToolDef[] {
    return this.toolDefs;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Connect, handshake or discover, and load the tool catalog.
   *
   * Concurrent callers share one attempt: the pool starts every server in parallel and
   * a `/mcp` retry can land on top of that, and two transports for one server would
   * leak a child process.
   */
  async connect(): Promise<void> {
    if (this.state === "disabled") return;
    if (this.state === "connected") return;
    if (this.connecting) return this.connecting;
    if (this.attempts >= MAX_CONNECT_ATTEMPTS && this.state !== "pending") return;
    this.connecting = this.attempt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Force a retry even past the cap — what `/mcp` reconnect does. */
  async reconnect(): Promise<void> {
    this.clearRetry();
    await this.closeTransport();
    this.closed = false;
    this.attempts = 0;
    this.state = this.config.disabled ? "disabled" : "pending";
    this.lastError = "";
    await this.connect();
  }

  private async attempt(): Promise<void> {
    this.attempts++;
    this.state = "pending";
    try {
      const transport = this.open();
      this.transport = transport;
      // If the server dies later, drop back to pending so a future call can revive it
      // instead of dispatching into a corpse.
      void transport.closed.then(() => {
        if (this.transport === transport) this.onDied();
      });

      const identity = { name: "mindweave", version: appVersion() };
      this.negotiated = await probe(
        {
          request: (method, params) => this.raw(transport, method, params),
          notify: (method, params) => transport.notify(method, params),
        },
        identity,
        DEFAULT_CLIENT_CAPABILITIES,
      );

      await this.loadTools();
      transport.onNotification((note) => this.onNotify(note));
      await this.subscribe(transport);
      this.state = "connected";
      this.lastError = "";
      this.attempts = 0; // a success clears the budget for the next outage
      this.changed();
    } catch (error) {
      await this.closeTransport();
      this.lastError = describeError(error);
      // A server asking for credentials is waiting on the user, not broken — and
      // retrying cannot help, so it does not consume the attempt budget's meaning.
      this.state = isAuthError(error) ? "needs-auth" : "failed";
      this.changed();
    }
  }

  /**
   * Opt into the change notifications we can actually act on.
   *
   * Best-effort by design: a server that does not support `subscriptions/listen` (every
   * pre-2026 one) or refuses the request is still perfectly usable, just with a catalog
   * that only refreshes when its TTL expires. Letting a failed subscription fail the
   * whole connection would drop most servers in existence for the sake of an optimization.
   */
  private async subscribe(transport: Transport): Promise<void> {
    if (!this.negotiated || this.negotiated.dialect !== "stateless") return;
    const types = subscriptionsFor(this.negotiated.capabilities);
    if (types.length === 0) return;
    try {
      if (transport.openStream) await transport.openStream("subscriptions/listen", { types });
      else await this.call("subscriptions/listen", { types });
    } catch {
      // No subscription; the TTL path still keeps the catalog roughly current.
    }
  }

  /** A server telling us something changed. Today only the tool list is actionable. */
  private onNotify(note: { method: string }): void {
    if (!isToolsChanged(note.method)) return;
    // Force past the TTL: the server just told us the cached answer is wrong.
    void this.loadTools(true)
      .then(() => this.changed())
      .catch(() => {
        // A refresh that fails leaves the previous catalog in place, which is strictly
        // better than dropping the tools because one notification could not be served.
      });
  }

  private open(): Transport {
    if (this.config.type === "http") {
      return new HttpTransport({ url: this.config.url, ...(this.config.headers ? { headers: this.config.headers } : {}) });
    }
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args,
      ...(this.config.env ? { env: this.config.env } : {}),
    });
  }

  /** A request that has NOT yet negotiated a dialect (the probe itself). */
  private raw(transport: Transport, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return transport.request(method, params);
  }

  /**
   * A request on the negotiated dialect: `_meta` is attached on stateless servers and
   * omitted on handshake ones, where it would be an unknown field.
   */
  private async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.transport || !this.negotiated) throw new RpcError(-32603, `mcp server '${this.config.name}' is not connected`);
    const meta = buildMeta(this.negotiated.dialect, this.negotiated.version, { name: "mindweave", version: appVersion() });
    const body = meta ? { ...(params ?? {}), _meta: meta } : params;
    return this.transport.request(method, body);
  }

  /** Fetch (or refresh) the tool catalog, honouring the server's own `ttlMs`. */
  async loadTools(force = false): Promise<void> {
    if (!force && this.toolsFetchedAt && this.cache.ttlMs !== undefined) {
      if (Date.now() - this.toolsFetchedAt < this.cache.ttlMs) return; // still fresh
    }
    const result = await this.call("tools/list");
    this.toolDefs = parseToolList(this.config.name, result);
    this.cache = cacheDirectiveOf(result);
    this.toolsFetchedAt = Date.now();
  }

  /** Invoke a tool on this server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call("tools/call", { name, arguments: args });
  }

  /**
   * The server went away on its own. Drop the catalog and schedule a revival.
   *
   * Automatic, because the alternative is that a server which crashed once is gone for
   * the rest of the session and the user has no way to know why their tools vanished.
   * Bounded, because a server that cannot come back never does.
   */
  private onDied(): void {
    this.transport = null;
    this.negotiated = null;
    this.toolDefs = [];
    this.toolsFetchedAt = 0;
    if (this.state === "connected") {
      this.state = "pending";
      this.lastError = "server exited";
      this.attempts = 0; // this is a NEW outage, not a continuation of the last one
      this.scheduleRetry();
    }
    this.changed();
  }

  private scheduleRetry(): void {
    if (this.closed || this.config.disabled) return;
    const delay = RECONNECT_BACKOFF_MS[this.attempts];
    if (delay === undefined) {
      // Out of automatic attempts. Say so plainly rather than sitting in `pending`
      // forever, which reads as "still trying".
      this.state = "failed";
      this.lastError = `${this.lastError || "server exited"} (gave up after ${RECONNECT_BACKOFF_MS.length} reconnect attempts; /mcp to retry)`;
      this.changed();
      return;
    }
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt().then(() => {
        if (this.state !== "connected") this.scheduleRetry();
      });
    }, delay);
    // Never hold the process open just to retry a background server.
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Tear down the transport but keep this connection revivable. */
  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.negotiated = null;
    this.toolDefs = [];
    this.toolsFetchedAt = 0;
    if (transport) await transport.close().catch(() => {});
  }

  /** Shut down for good: no more retries, no more tools. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearRetry();
    await this.closeTransport();
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsupportedProtocolVersionError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
