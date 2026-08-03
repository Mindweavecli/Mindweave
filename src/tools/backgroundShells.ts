/**
 * backgroundShells.ts — long-running commands that outlive a turn.
 *
 * When a command crosses its timeout (or the model asks for `run_in_background`),
 * run_command hands the LIVE process to this manager instead of killing it. The
 * manager owns the registry of background shells per session, buffers their output
 * (capped, so a chatty dev server never floods memory or the model's context), and
 * exposes:
 *
 *   - `read(id)`  — only the NEW output since the last read (incremental).
 *   - `kill(id)`  — whole-tree kill.
 *   - `list()`    — running + finished shells (for the UI and /shells).
 *
 * Two ONE-SHOT, self-cleaning notification channels keep completions from leaking
 * (avoiding the common footgun where finished jobs re-inject into the model forever):
 *   - `takeUiNotifications()` — finished shells not yet shown in the chat.
 *   - `drainCompleted()`      — finished shells not yet reported to the MODEL (with
 *                               a tail), so the model is told once, then never again.
 *
 * Client-side, like the alternator lanes: it holds live process handles, never
 * crosses the engine↔brain wire. All children are killed on process exit.
 */
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { killTree, killTreeSync } from "./killTree.js";

const MAX_BUFFER_CHARS = 5_000_000; // cap one shell's retained output (runaway server)
const MAX_READ_CHARS = 30_000; // cap a single shell_output read
const TAIL_CHARS = 2_000; // how much trailing output rides on a completion note

/**
 * How long a server has to stay up before we treat its death as "someone stopped it"
 * rather than "it failed to start".
 *
 * This is the one honest way to tell the two apart, because the exit status cannot:
 * measured on Windows, a user closing an app reports `code 1`, and so does a server
 * that crashed because its port was taken. Duration separates them cleanly — a port
 * conflict dies in under a second, a session you close has been up for minutes.
 *
 * Borrowed from process supervisors, which hit this decades ago: supervisord counts a
 * program as failed-to-start if it exits before `startsecs` (default 1s) regardless of
 * its exit code. 10s is deliberately generous, since a dev server can take several
 * seconds to bind a port and fail.
 */
const STARTUP_GRACE_MS = 10_000;

/**
 * How long to wait after `exit` for `close` before finalizing anyway.
 *
 * `close` fires only once every stdio stream is closed, and a surviving grandchild can
 * hold the pipe open forever, which strands the entry as permanently "running".
 * `exit` fires when the process itself goes, so it is the backstop; the delay lets
 * `close` win normally so buffered output is not lost.
 */
const EXIT_GRACE_MS = 2_000;

export type ShellStatus = "running" | "exited" | "killed";

/**
 * Is this command a dev server / interactive app — something that runs until stopped,
 * where "it exited" means the USER closed it, NOT that a task finished? (pure/tested)
 *
 * This is the type-awareness the background system was missing: a finite task (build,
 * test, lint) that finishes IS a result worth surfacing to the model, but a dev server
 * (`tauri dev`, `vite`, `npm run dev`) exiting cleanly is just the user closing their
 * app — reacting to it makes the model "helpfully" reopen the thing they just closed.
 * `build` variants (`vite build`, `tauri build`) are finite tasks, so they're excluded
 * even though they share a runner name.
 */
export function isInteractiveServerCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/\bbuild\b/.test(c)) return false; // `next build`, `tauri build`, `vite build` — finite
  // Package-runner dev/serve/start/preview scripts: `npm run dev`, `pnpm start`, `yarn serve`.
  if (/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(dev|serve|start|preview)\b/.test(c)) return true;
  // Dev servers / desktop-app runners invoked directly.
  return /\b(tauri|vite|next|nuxt|remix|astro|nodemon|electron|expo|ng|http-server|live-server|serve|webpack-dev-server|watchexec)\b/.test(
    c,
  );
}

/**
 * Should a finished shell WAKE THE MODEL? (pure/tested)
 *
 * The old rule was `interactive && (killed || code === 0)`, which assumed a closed app
 * exits 0. Measured, it does not: `taskkill /T` (what `/shells`, `killTree`, and
 * closing a console app all amount to) reports **code 1**, and SIGTERM/SIGINT report
 * `code null`. Three of the four ways an app can end therefore fell through, the model
 * was told its dev server had "failed", and it restarted the thing the user had just
 * closed — every time, forever.
 *
 * The rule now asks what actually happened rather than reading a number that means
 * different things on different platforms:
 *
 *   - a finite task (build, test, lint) always reports: its result is the whole point
 *   - we killed it ourselves → the agent or the user did that on purpose, say nothing
 *   - a signal ended it → SIGTERM/SIGINT is someone stopping it, not a crash
 *   - a clean exit 0 → it stopped on its own terms
 *   - anything else → report ONLY if it died inside the startup grace, which is a
 *     server that never came up (port taken, bad config) and is worth surfacing
 */
export function shouldNotifyModel(end: {
  interactive: boolean;
  killed: boolean;
  code: number | null;
  signal: string | null;
  ranForMs: number;
}): boolean {
  if (!end.interactive) return true;
  if (end.killed) return false;
  if (end.signal) return false;
  if (end.code === 0) return false;
  return end.ranForMs < STARTUP_GRACE_MS;
}

/**
 * Is `command` already running as one of these shells? (pure/tested) Matches on the
 * normalized command string, so launching the very same server a second time is caught
 * — the failure where the model fires `npm run tauri dev` twice, the copies collide on
 * the port, and it then fights the conflict it created. Distinct servers (a frontend and
 * a backend) don't match each other, so running both is still fine.
 */
export function findRunningDuplicate(
  running: readonly ShellInfo[],
  command: string,
): ShellInfo | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(command);
  return running.find((s) => norm(s.command) === target);
}

/** Plain, serializable view of a background shell (what tools/UI see). */
export interface ShellInfo {
  id: number;
  command: string;
  cwd: string;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface AdoptOptions {
  command: string;
  cwd: string;
  /** Output already collected before the hand-off (foreground → background). */
  initial?: string;
  /** A temp cwd-file from run_command to clean up when the process ends. */
  cwdFile?: string;
}

interface Entry extends ShellInfo {
  child: ChildProcess | null;
  buffer: string; // retained output (capped)
  readOffset: number; // chars already handed out by read()
  truncated: boolean;
  reported: boolean; // told to the model yet?
  uiNotified: boolean; // shown in the chat yet?
  interactive: boolean; // a dev server / app (exit = user closed it), not a finite task
  cwdFile?: string;
}

const active = new Set<BackgroundShells>();
let cleanupRegistered = false;

export class BackgroundShells {
  private seq = 0;
  private shells = new Map<number, Entry>();
  private onChange: (() => void) | null = null;

  constructor() {
    active.add(this);
    registerCleanup();
  }

  /** Subscribe to state changes (start / finish / kill) — the UI re-renders. */
  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }

  /** Take ownership of a live child process and start buffering its output. */
  adopt(child: ChildProcess, opts: AdoptOptions): ShellInfo {
    const id = ++this.seq;
    const entry: Entry = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      child,
      buffer: "",
      readOffset: 0,
      truncated: false,
      reported: false,
      uiNotified: false,
      interactive: isInteractiveServerCommand(opts.command),
      cwdFile: opts.cwdFile,
    };
    this.shells.set(id, entry);
    if (opts.initial) this.append(entry, opts.initial);

    const collect = (chunk: Buffer) => this.append(entry, chunk.toString("utf8"));
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    // `signal` is captured, not dropped: a process ended by SIGTERM/SIGINT reports
    // `code === null`, and without the signal there is no way to tell that from a
    // crash.
    child.on("close", (code, signal) => this.onClose(entry, code, signal, false));
    child.on("error", () => this.onClose(entry, null, null, false));
    // Backstop for a `close` that never arrives because a surviving grandchild still
    // holds the stdio pipe. Without this the entry stays "running" for the rest of the
    // session: the UI shows a dead shell, and `runningCount()` is permanently wrong.
    child.on("exit", (code, signal) => {
      const timer = setTimeout(() => this.onClose(entry, code, signal, false), EXIT_GRACE_MS);
      timer.unref?.();
    });

    this.emit();
    return view(entry);
  }

  private append(entry: Entry, text: string): void {
    entry.buffer += text;
    if (entry.buffer.length > MAX_BUFFER_CHARS) {
      // Keep the tail — the recent output is what matters for tests/errors.
      entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS);
      entry.readOffset = Math.min(entry.readOffset, entry.buffer.length);
      entry.truncated = true;
    }
  }

  private onClose(entry: Entry, code: number | null, signal: string | null, killed: boolean): void {
    if (entry.status !== "running") return;
    entry.status = killed ? "killed" : "exited";
    entry.exitCode = code;
    entry.finishedAt = Date.now();
    entry.child = null;
    // Decide whether this end is worth waking the model for. Marking it already
    // reported is what stops the "reopen the app they just closed" loop. The UI still
    // shows the stop either way (uiNotified is untouched), so the user always sees it.
    if (
      !shouldNotifyModel({
        interactive: entry.interactive,
        killed,
        code,
        signal,
        ranForMs: entry.finishedAt - entry.startedAt,
      })
    ) {
      entry.reported = true;
    }
    if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
    this.emit();
  }

  /** New output since the last read of this shell, plus its current status. */
  async read(id: number): Promise<{ info: ShellInfo; chunk: string } | null> {
    const entry = this.shells.get(id);
    if (!entry) return null;
    let chunk = entry.buffer.slice(entry.readOffset);
    entry.readOffset = entry.buffer.length;
    if (chunk.length > MAX_READ_CHARS) {
      chunk = `… (earlier output omitted)\n${chunk.slice(chunk.length - MAX_READ_CHARS)}`;
    }
    return { info: view(entry), chunk };
  }

  /** Kill a running shell (whole tree). Returns false if it isn't running. */
  kill(id: number): boolean {
    const entry = this.shells.get(id);
    if (!entry || entry.status !== "running" || !entry.child) return false;
    killTree(entry.child.pid);
    this.onClose(entry, null, null, true);
    return true;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map(view);
  }
  running(): ShellInfo[] {
    return this.list().filter((s) => s.status === "running");
  }
  runningCount(): number {
    return this.running().length;
  }
  /** Finished shells the model hasn't been told about yet. */
  pendingCount(): number {
    return [...this.shells.values()].filter((e) => e.status !== "running" && !e.reported).length;
  }

  /** One-shot for the UI: finished shells not yet shown in the chat. */
  takeUiNotifications(): ShellInfo[] {
    const out: ShellInfo[] = [];
    for (const entry of this.shells.values()) {
      if (entry.status !== "running" && !entry.uiNotified) {
        entry.uiNotified = true;
        out.push(view(entry));
      }
    }
    return out;
  }

  /** One-shot for the MODEL: finished shells not yet reported, each with a tail of
   *  output. Marked reported so they're never injected again. */
  async drainCompleted(): Promise<{ info: ShellInfo; tail: string }[]> {
    const out: { info: ShellInfo; tail: string }[] = [];
    for (const entry of this.shells.values()) {
      if (entry.status !== "running" && !entry.reported) {
        entry.reported = true;
        out.push({ info: view(entry), tail: entry.buffer.slice(Math.max(0, entry.buffer.length - TAIL_CHARS)) });
      }
    }
    return out;
  }

  /**
   * Kill every running shell and drop the registry (session swap / exit).
   *
   * `sync` is required when disposing from a process-exit handler: the default
   * kill spawns `taskkill` asynchronously, and Node runs no async work during
   * exit, so the shells would outlive us. Measured, not assumed.
   */
  dispose(sync = false): void {
    for (const entry of this.shells.values()) {
      if (entry.status === "running" && entry.child) {
        if (sync) killTreeSync(entry.child.pid);
        else killTree(entry.child.pid);
      }
      if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
    }
    this.shells.clear();
    active.delete(this);
  }

  private emit(): void {
    this.onChange?.();
  }
}

function view(e: Entry): ShellInfo {
  return {
    id: e.id,
    command: e.command,
    cwd: e.cwd,
    status: e.status,
    exitCode: e.exitCode,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}

/** Kill any background processes still running when the process exits. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    // Synchronous kill: an async one never reaches the OS from here.
    for (const mgr of active) mgr.dispose(true);
  });
}
