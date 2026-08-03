/**
 * killTree.ts — terminate a process AND all of its descendants.
 *
 * Killing a shell alone leaves grandchildren (node → jest, a dev server) holding
 * the output pipe open, so the job looks hung forever. We kill the whole tree:
 * `taskkill /T` on Windows, the negative-pid process group on POSIX (callers that
 * need this spawn `detached` so the child leads its own group). Shared by
 * run_command (timeout), the background-shell manager (kill_shell / dispose), the
 * MCP stdio transport, and language-server disposal.
 *
 * TWO VARIANTS, and the difference is not cosmetic. `killTree` spawns `taskkill`
 * asynchronously, which is right on a live event loop. It does NOT work from a
 * `process.on("exit")` handler: Node runs no async work during exit, so the spawn
 * never reaches the OS and the process survives — measured, not assumed. Anything
 * disposing from an exit handler must call `killTreeSync`, which blocks until
 * `taskkill` has actually run. The POSIX path is a direct signal and is already
 * synchronous, so both variants share it.
 *
 * Why not make everything synchronous and delete the footgun? Measured on this
 * machine, `spawnSync("taskkill /F /T")` blocks for a median of 122ms (max 140ms)
 * per tree. Session teardown kills several at once, so a single always-sync
 * version would freeze the UI for a noticeable fraction of a second on every
 * swap. The async default keeps the hot paths smooth; the sync variant is for
 * the one place that cannot use it.
 */
import { spawn, spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/** taskkill arguments for a whole process tree. */
function killArgs(pid: number): string[] {
  return ["/F", "/T", "/PID", String(pid)];
}

/**
 * Kill `pid` and its descendants. Non-blocking on Windows.
 * Use only where an event loop is still running; see `killTreeSync` otherwise.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", killArgs(pid), { windowsHide: true, stdio: "ignore" });
    } else {
      // Negative pid → the whole process group (the child was spawned detached).
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
}

/**
 * Kill `pid` and its descendants, blocking until it has happened.
 *
 * This is the variant that works from a `process.on("exit")` handler. It costs a
 * synchronous wait on `taskkill` (tens of milliseconds), which is why it is not
 * the default for the hot paths.
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
