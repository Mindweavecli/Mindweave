/**
 * manager.ts — the pool of MCP servers, and the only thing the engine talks to.
 *
 * Everything above this file sees tools, not servers. `toolSchemas()` merges into the
 * model's tool list and `asTool()` returns something indistinguishable from a built-in,
 * so an MCP tool is dispatched, displayed, gated and logged by the same machinery as
 * `read_file`. That seam is the whole reason MCP does not leak into the engine.
 *
 * The governing rule is BEST-EFFORT: a server that will not start, will not answer, or
 * dies halfway is skipped, and the session keeps working with the built-in tools. MCP
 * is the user pointing at third-party code; it must never be able to take the agent
 * down with it.
 *
 * On CACHING: tool schemas are rendered before the providers' cache breakpoint, so a
 * catalog that changes invalidates the cached prompt prefix. It cannot be moved out of
 * the way — `tools` is a structural API field, not text, so there is no "volatile tail"
 * to put it in and still have native function-calling work. What we do instead is make
 * the catalog STABLE: a fixed sort order (`sortCatalog`), capped descriptions, and one
 * frozen `snapshot()` per turn. The cost then lands where it should — once per real
 * catalog change — instead of once per turn or, worse, once per step.
 */
import type { Tool, ToolResult, ToolSchema } from "../tools/types.js";
import {
  estimateCatalogTokens,
  flattenContent,
  frameUntrusted,
  mcpToolName,
  parseMcpToolName,
  sortCatalog,
  toolSchemas as schemasFor,
  type McpToolDef,
} from "./catalog.js";
import { McpConnection, type ConnectionStatus } from "./connection.js";
import { searchCatalog, shouldDefer } from "./deferred.js";
import { compareTrust, acceptTools, changedToolsQuestion, type TrustRecord } from "./trust.js";
import { loadTrust, saveTrust } from "./trustStore.js";
import type { McpServerConfig } from "./config.js";

/**
 * One turn's frozen view of the MCP catalog: what the model is told it can call, and
 * what it can actually call, guaranteed to be the same set.
 */
export interface McpSnapshot {
  /**
   * The tools ADVERTISED to the model right now. Read per step rather than fixed at
   * snapshot time, because activating a deferred tool has to take effect on the very
   * next step — otherwise the model searches, is told it found something, and then
   * still cannot call it.
   */
  exposedSchemas(): ToolSchema[];
  /** Approximate prompt-token cost of what is currently exposed. */
  tokens(): number;
  /** True when the catalog is large enough that tools are held behind search. */
  deferred: boolean;
  /** Everything this server pool had at snapshot time, exposed or not. */
  catalog: readonly McpToolDef[];
  toolCount: number;
  /**
   * Resolve ANY tool in the frozen catalog, exposed or not. Deliberately wider than
   * `exposedSchemas`: a model that guesses a correct name should be allowed to call it
   * rather than be told a tool it named correctly does not exist.
   */
  asTool(name: string): Tool | undefined;
}

/**
 * Wrap one MCP tool def as a runnable Tool. Shared by the live lookup and the per-turn
 * snapshot so both dispatch through exactly the same path.
 */
function buildTool(name: string, def: McpToolDef, connection: McpConnection): Tool {
  return {
    name,
    description: def.description,
    parameters: def.inputSchema,
    readOnly: def.readOnly,
    async execute(args): Promise<ToolResult> {
      try {
        const result = await connection.callTool(def.name, args);
        const { text, isError } = flattenContent(result);
        // Framed as data, not instruction: this text is written by a third party and
        // lands where the model trusts built-in tool output.
        return { output: frameUntrusted(def.server, text), summary: name, ...(isError ? { isError: true } : {}) };
      } catch (error) {
        // A tool failure is a tool RESULT, not an exception: the model should see it,
        // reason about it, and try something else — the same contract as a failed shell
        // command. This is also where a server that died mid-turn surfaces, which is why
        // the snapshot can keep offering it without lying.
        return {
          output: `Error: MCP tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          summary: `${name} failed`,
        };
      }
    },
  };
}

/** The two answers to a changed-description prompt. */
const ALLOW_CHANGED = "Allow the changed tools";
const BLOCK_CHANGED = "Block them this session";

/** How many servers to bring up at once. Enough to start fast, bounded so a config
 *  with twenty servers does not spawn twenty processes in the same instant. */
const CONNECT_BATCH = 6;

let cleanupRegistered = false;
const live = new Set<McpManager>();

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private started = false;
  private onChange: (() => void) | null = null;
  /** Deferred tools the model has searched for and may now call. Session-lived. */
  private activated = new Set<string>();
  /** Fingerprints of tools the user has accepted, loaded from the project's state dir. */
  private trust: TrustRecord = {};
  /** Tools blocked because their description moved and the user declined. */
  private quarantined = new Set<string>();
  /** Tool names the project's governor forbids outright (`forbid_mcp_tool`). */
  private forbidden = new Set<string>();
  /**
   * One-shot messages the user needs to see. Drained by the CLI, never re-sent.
   *
   * Blocking a tool with no visible explanation is barely better than not blocking it:
   * the user sees a shorter tool list, assumes the server is broken, and has nothing to
   * act on. Mirrors `BackgroundShells.takeUiNotifications`, which solved the same
   * problem for finished shells.
   */
  private notices: string[] = [];
  /** The project root, remembered from the trust check so a later review can re-save. */
  private trustCwd = "";

  /**
   * Told whenever any server's state or catalog moves, so the CLI can repaint.
   *
   * Servers connect in the background and can die or revive at any moment, so without
   * this the UI would only ever show whatever was true when the last key was pressed.
   * Mirrors `BackgroundShells.setOnChange`, which solved the same problem.
   */
  setOnChange(handler: (() => void) | null): void {
    this.onChange = handler;
    for (const connection of this.connections.values()) connection.setOnChange(handler ? () => this.onChange?.() : null);
  }

  /** Bring up every configured server. Never rejects: failures become states. */
  async start(configs: readonly McpServerConfig[], log?: (message: string) => void): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (configs.length === 0) return;
    registerCleanup();
    live.add(this);

    for (const config of configs) {
      const connection = new McpConnection(config);
      connection.setOnChange(() => this.onChange?.());
      this.connections.set(config.name, connection);
    }

    const pending = [...this.connections.values()].filter((c) => !c.config.disabled);
    for (let i = 0; i < pending.length; i += CONNECT_BATCH) {
      await Promise.all(
        pending.slice(i, i + CONNECT_BATCH).map(async (connection) => {
          // `connect` already converts failure into state; this catch is for the
          // genuinely unexpected, so one bad server cannot reject the whole batch.
          await connection.connect().catch(() => {});
          const status = connection.status();
          log?.(
            status.state === "connected"
              ? `mcp ${status.name}: ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (${status.version}${status.legacy ? ", legacy" : ""})`
              : `mcp ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ""}`,
          );
        }),
      );
    }
  }

  /**
   * Check the connected catalog against the fingerprints this project accepted before,
   * and quarantine anything whose description or schema moved until the user says
   * otherwise.
   *
   * Called after `start()`, with the project root and the approval channel, so the pool
   * itself stays free of both filesystem and UI concerns. Fail-open on the mechanics
   * (an unreadable record means everything reads as fresh) but fail-CLOSED on the
   * decision: with no approval channel to ask through, changed tools stay blocked.
   */
  async verifyTrust(cwd: string, ask?: (question: string, options: string[]) => Promise<string>): Promise<void> {
    const defs = this.catalog();
    if (defs.length === 0) return;
    this.trustCwd = cwd;
    this.trust = await loadTrust(cwd);
    const verdict = compareTrust(defs, this.trust);

    // First sight is trusted by construction — there is nothing to compare against.
    // Recording it is what makes the NEXT change detectable.
    if (verdict.fresh.length > 0) {
      this.trust = acceptTools(this.trust, defs, verdict.fresh);
    }

    if (verdict.changed.length > 0) {
      const allow = ask ? await ask(changedToolsQuestion(verdict.changed), [ALLOW_CHANGED, BLOCK_CHANGED]) : BLOCK_CHANGED;
      if (allow === ALLOW_CHANGED) {
        this.trust = acceptTools(this.trust, defs, verdict.changed);
        for (const name of verdict.changed) this.quarantined.delete(name);
      } else {
        // Blocked for the session. The stored fingerprint is left ALONE so the same
        // question is asked again next session rather than the change being forgotten.
        for (const name of verdict.changed) this.quarantined.add(name);
        // Say so. Without this the user just sees fewer tools — which reads as a broken
        // server, not a security decision they can act on. This is also the safety net
        // for the case where there was no approval channel to ask through at all.
        this.notices.push(
          `Blocked ${verdict.changed.length} MCP tool${verdict.changed.length === 1 ? "" : "s"} whose description ` +
            `changed since you last used ${verdict.changed.length === 1 ? "it" : "them"}: ${verdict.changed.join(", ")}. ` +
            `Run /mcp to review.`,
        );
        this.onChange?.();
      }
    }

    if (verdict.fresh.length > 0 || verdict.changed.length > 0) await saveTrust(cwd, this.trust);
  }

  /**
   * Re-offer the currently quarantined tools, so a block is recoverable in-session.
   *
   * Needed because the automatic check runs while the pool connects in the background,
   * possibly before the CLI has an approval channel to ask through. That path fails
   * closed and silent by design; this is how the user gets the question back.
   */
  async reviewQuarantine(ask: (question: string, options: string[]) => Promise<string>): Promise<boolean> {
    const blocked = this.quarantinedNames();
    if (blocked.length === 0) return false;
    const answer = await ask(changedToolsQuestion(blocked), [ALLOW_CHANGED, BLOCK_CHANGED]);
    if (answer !== ALLOW_CHANGED) return false;
    this.trust = acceptTools(this.trust, this.catalog(), blocked);
    for (const name of blocked) this.quarantined.delete(name);
    if (this.trustCwd) await saveTrust(this.trustCwd, this.trust);
    this.onChange?.();
    return true;
  }

  /** Drain user-facing notices. One-shot: each is reported exactly once. */
  takeNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /** How many of a server's tools are currently blocked, for `/mcp`. */
  blockedCountFor(server: string): number {
    const prefix = mcpToolName(server, "");
    return this.quarantinedNames().filter((n) => n.startsWith(prefix)).length;
  }

  /** Apply the project's forbidden-MCP-tool list. Replaces the previous set. */
  setForbidden(names: readonly string[]): void {
    this.forbidden = new Set(names);
    // A tool that becomes forbidden must not linger in the activated set, or a deferred
    // catalog would keep advertising it.
    for (const name of names) this.activated.delete(name);
  }

  /** Tools currently blocked because their description changed. */
  quarantinedNames(): string[] {
    return [...this.quarantined].sort();
  }

  /**
   * Bring one server up NOW, without restarting the session.
   *
   * Adding a server and then being told to restart would make the add path useless —
   * the whole point is that you say what you want and it is there. Replaces any server
   * of the same name, shutting the old one down first so we never leak a child process
   * on a re-add.
   */
  async addServer(config: McpServerConfig): Promise<ConnectionStatus> {
    registerCleanup();
    live.add(this);
    this.started = true;

    const previous = this.connections.get(config.name);
    if (previous) await previous.close().catch(() => {});

    const connection = new McpConnection(config);
    connection.setOnChange(() => this.onChange?.());
    this.connections.set(config.name, connection);
    if (!config.disabled) await connection.connect().catch(() => {});
    // A re-added server is a different server as far as trust goes; drop any stale
    // activation so a deferred catalog does not advertise tools it no longer has.
    for (const name of this.activatedNames()) {
      if (name.startsWith(mcpToolName(config.name, ""))) this.activated.delete(name);
    }
    this.onChange?.();
    return connection.status();
  }

  /** Every server's state, for `/mcp` and for diagnostics. */
  statuses(): ConnectionStatus[] {
    return [...this.connections.values()].map((c) => c.status()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Force a reconnect of one server by name. Returns its state afterwards. */
  async reconnect(name: string): Promise<ConnectionStatus | null> {
    const connection = this.connections.get(name);
    if (!connection) return null;
    await connection.reconnect().catch(() => {});
    this.onChange?.();
    return connection.status();
  }

  /** True when there is anything at all to show in `/mcp`. */
  hasServers(): boolean {
    return this.connections.size > 0;
  }

  /**
   * A frozen view of the catalog for ONE turn.
   *
   * The engine advertises a tool list to the model and then dispatches whatever it
   * calls, and those were two separate reads of live state. In between, a server can
   * die or send `notifications/tools/list_changed` — so a tool the model was OFFERED at
   * the top of the turn could be gone by the time it called it, and the model would be
   * told "no such tool" for something we had just told it about. That is a confusing
   * failure to debug and an easy one to blame on the model.
   *
   * Taking one snapshot and using it for both halves makes the turn internally
   * consistent: what was offered stays callable. If the underlying server really has
   * gone, the call fails at dispatch with a real error the model can act on, which is
   * an honest outcome rather than a contradiction.
   *
   * It also pins the exact bytes sent as `tools` for the turn, which is what keeps the
   * cached prompt prefix intact across the turn's steps.
   */
  snapshot(readOnlyOnly = false): McpSnapshot {
    const defs = this.allowedCatalog().filter((d) => !readOnlyOnly || d.readOnly);
    // Bind each def to the connection that owned it AT SNAPSHOT TIME, so dispatch does
    // not go looking through a pool that may have changed underneath us.
    const owners = new Map<string, McpConnection>();
    for (const connection of this.connections.values()) {
      for (const def of connection.tools()) owners.set(mcpToolName(def.server, def.name), connection);
    }
    const deferred = shouldDefer(defs.length);
    // Under the threshold everything is exposed; over it, only what has been activated.
    const exposed = (): McpToolDef[] => (deferred ? defs.filter((d) => this.activated.has(mcpToolName(d.server, d.name))) : defs);
    return {
      deferred,
      catalog: defs,
      toolCount: defs.length,
      exposedSchemas: () => schemasFor(exposed(), readOnlyOnly),
      tokens: () => estimateCatalogTokens(exposed()),
      asTool: (name) => {
        const def = defs.find((d) => mcpToolName(d.server, d.name) === name);
        const connection = owners.get(name);
        if (!def || !connection) return undefined;
        return buildTool(name, def, connection);
      },
    };
  }

  /**
   * Search the catalog and ACTIVATE what matches, so those tools are advertised from
   * the next step onward.
   *
   * Activation is sticky for the session on purpose. A tool the model reached for once
   * it will likely reach for again, and re-hiding it would mean another search round
   * trip and another change to the advertised tool list — which is the thing that costs
   * a prompt-cache prefix. Paying once and keeping it is cheaper than paying repeatedly.
   */
  searchAndActivate(query: string): McpToolDef[] {
    const found = searchCatalog(query, this.allowedCatalog());
    for (const def of found) this.activated.add(mcpToolName(def.server, def.name));
    return found;
  }

  /** Tool names currently advertised out of a deferred catalog (for diagnostics). */
  activatedNames(): string[] {
    return [...this.activated].sort();
  }

  /**
   * Roughly what the live catalog costs in prompt tokens.
   *
   * The compaction bars measure the transcript only, so without this correction a large
   * MCP catalog makes every threshold fire that much too late.
   */
  estimatedTokens(): number {
    // What is SENT, not what exists: a deferred catalog costs only its activated part,
    // and counting the hidden remainder would make the compaction bars fire early for
    // tokens the model never receives.
    return this.snapshot().tokens();
  }

  /** Every tool across every connected server, in a stable order. */
  private catalog(): McpToolDef[] {
    return sortCatalog([...this.connections.values()].filter((c) => c.isConnected()).flatMap((c) => [...c.tools()]));
  }

  /**
   * The catalog minus anything the user has blocked. ONE chokepoint for both governance
   * gates, so a blocked tool cannot be advertised, searched, activated or dispatched —
   * there is no path that consults the raw catalog instead.
   */
  private allowedCatalog(): McpToolDef[] {
    return this.catalog().filter((d) => {
      const name = mcpToolName(d.server, d.name);
      return !this.quarantined.has(name) && !this.forbidden.has(name);
    });
  }

  /** How many tools are currently offered (for status lines and budgeting). */
  toolCount(): number {
    return this.allowedCatalog().length;
  }

  /** Schemas for every MCP tool. `readOnlyOnly` drops mutating tools, mirroring the
   *  built-in registry's behaviour in plan mode and read-only sub-agents. */
  toolSchemas(readOnlyOnly = false): ToolSchema[] {
    return schemasFor(this.allowedCatalog(), readOnlyOnly);
  }

  /**
   * Resolve an advertised MCP name to a runnable Tool, or undefined if we do not serve
   * it. Returning undefined (rather than a tool that errors) is what lets the engine's
   * lookup fall through to its normal "no such tool" path.
   */
  asTool(name: string): Tool | undefined {
    const parsed = parseMcpToolName(name);
    if (!parsed) return undefined;
    // Resolve against the ALLOWED catalog, not the raw connections. Reading the
    // connections directly was a hole: a forbidden or quarantined tool stayed
    // dispatchable through this path even though it was gone from every list. A gate
    // that closes three of four doors is not a gate.
    const def = this.allowedCatalog().find((d) => mcpToolName(d.server, d.name) === name);
    if (!def) return undefined;
    // Config names are normalized on the way INTO a tool name, so a server called
    // "acme.tools" is looked up by its normalized form here.
    const connection = [...this.connections.values()].find(
      (c) => c.isConnected() && mcpToolName(c.config.name, "x") === mcpToolName(parsed.server, "x"),
    );
    if (!connection) return undefined;
    return buildTool(name, def, connection);
  }

  async dispose(): Promise<void> {
    const closing = [...this.connections.values()].map((c) => c.close().catch(() => {}));
    this.connections.clear();
    live.delete(this);
    await Promise.all(closing);
  }
}

/** Kill any servers still running when the process exits. Child processes do not die
 *  with their parent on every platform, and an orphaned server holds a port or a lock. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const manager of live) void manager.dispose();
  });
}
