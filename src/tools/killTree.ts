/**
 * killTree.ts — terminate a process AND all of its descendants.
 *
 * Killing a shell alone leaves grandchildren (node → jest, a dev server) holding
 * the output pipe open, so the job looks hung forever. We kill the whole tree:
 * `taskkill /T` on Windows, the negative-pid process group on POSIX (callers that
 * need this spawn `detached` so the child leads its own group). Shared by
 * run_command (timeout) and the background-shell manager (kill_shell / dispose).
 */
import { spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } else {
      // Negative pid → the whole process group (the child was spawned detached).
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
}
