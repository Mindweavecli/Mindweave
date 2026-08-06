/**
 * killTree.ts — spawning a child we can later kill completely, and killing it.
 *
 * Spawn and kill live in ONE module because they share one invariant. Killing a
 * shell alone leaves grandchildren (node → jest, npx → the real server, a dev
 * server) holding the output pipe open, so the job looks hung forever. Killing the
 * whole tree needs `taskkill /T` on Windows and the negative-pid process group on
 * POSIX — and the process group only exists if the child was spawned `detached`.
 *
 * That invariant used to be a sentence in a comment, and two of the three callers
 * did not honour it: the MCP stdio transport and the language-server host both
 * spawned attached and then skipped the tree kill entirely off Windows, so on macOS
 * and Linux only the direct child was ever signalled and its children were orphaned.
 * `spawnManaged` exists so that cannot happen again: every child that will later be
 * tree-killed is created through it, and it sets the group up correctly by
 * construction rather than by remembering.
 *
 * TWO KILL VARIANTS, and the difference is not cosmetic. `killTree` is asynchronous
 * and escalates politely. It does NOT work from a `process.on("exit")` handler: Node
 * runs no async work during exit, so neither a spawn nor a timer ever reaches the
 * OS and the process survives — measured, not assumed. Anything disposing from an
 * exit handler must call `killTreeSync`, which blocks and goes straight to the
 * forceful signal because there is no time left to be polite.
 *
 * Why not make everything synchronous and delete the footgun? Measured on this
 * machine, `spawnSync("taskkill /F /T")` blocks for a median of 122ms (max 140ms)
 * per tree. Session teardown kills several at once, so an always-sync version would
 * freeze the UI for a noticeable fraction of a second on every swap.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * How long a process gets to shut down cleanly before it is killed outright.
 *
 * POSIX only, and it matters: a dev server, a language server, or an MCP server
 * asked to stop will flush state, release a port, and close a socket if it is given
 * a chance. Going straight to SIGKILL — which is what this module used to do — denies
 * that, and the cost shows up later as a held port or a half-written file.
 */
const TERM_GRACE_MS = 2_000;

/** taskkill arguments for a whole process tree. */
function killArgs(pid: number): string[] {
  return ["/F", "/T", "/PID", String(pid)];
}

/**
 * Spawn a child that can later be tree-killed.
 *
 * Use this for any process with a lifetime — a shell command, an MCP server, a
 * language server. On POSIX it becomes its own process-group leader, which is the
 * precondition `killTree` depends on; on Windows the group is handled by `taskkill
 * /T` and nothing extra is needed. Callers keep full control of stdio, cwd and env;
 * only the group setting is decided here, because that is the part that has to be
 * consistent for the kill path to work.
 */
export function spawnManaged(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args as string[], {
    ...options,
    windowsHide: options.windowsHide ?? true,
    // POSIX: lead our own process group so the whole tree can be signalled at once.
    // Windows has no process groups in this sense; taskkill /T walks the tree instead.
    detached: IS_WINDOWS ? false : (options.detached ?? true),
  });
}

/**
 * Kill `pid` and everything beneath it. Non-blocking.
 *
 * POSIX escalates: SIGTERM to the group, then SIGKILL to whatever is still there
 * after the grace period. Windows uses `taskkill /F /T`, which is already a forced
 * whole-tree kill. Use only where an event loop is still running; see `killTreeSync`.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", killArgs(pid), { windowsHide: true, stdio: "ignore" });
      return;
    }
    // Negative pid → the whole process group (spawnManaged made the child its leader).
    process.kill(-pid, "SIGTERM");
    const escalate = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Gone during the grace period, which is the outcome we wanted.
      }
    }, TERM_GRACE_MS);
    // Never hold the process open just to deliver a follow-up kill.
    escalate.unref?.();
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
}

/**
 * Kill `pid` and its descendants, blocking until it has happened.
 *
 * The variant that works from a `process.on("exit")` handler. No grace period: the
 * process is on its way out and there is no event loop left to deliver a follow-up
 * signal on, so a polite first attempt would simply be the only attempt and would
 * leave anything that ignores SIGTERM running.
 */
export function killTreeSync(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", killArgs(pid), { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
}
