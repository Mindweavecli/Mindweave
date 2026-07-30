/**
 * lane.ts — the alternator: start the chassis, warm it from cache, keep it fresh.
 *
 * `startChassis` returns the chassis handle immediately and does the work off the
 * hot path: load the on-disk cache (near-instant warm start), reconcile changed
 * files, save the cache, then reconcile periodically so the map tracks edits. All
 * deterministic — no model calls, no tokens. A failure just leaves the chassis
 * degraded (tools fall back to grep/read).
 *
 * Freshness is a periodic mtime reconcile rather
 * than a live file-watcher: simpler, dependency-free, no watcher edge cases, and
 * it fits the always-on background thesis. Tunable via MINDWEAVE_CHASSIS_REFRESH_MS
 * (0 disables).
 */
import { CodeChassis } from "./chassis/index.js";
import type { Chassis } from "./chassis/types.js";

function refreshMs(): number {
  const v = Number(process.env.MINDWEAVE_CHASSIS_REFRESH_MS);
  return Number.isFinite(v) && v >= 0 ? v : 8_000;
}

const active = new Set<CodeChassis>();
let cleanupRegistered = false;

/** Create a chassis for `root`, warm it from cache, and keep it fresh — all in
 *  the background. Returns immediately. */
export function startChassis(root: string): Chassis {
  const chassis = new CodeChassis(root);
  active.add(chassis);
  registerCleanup();
  void (async () => {
    try {
      await chassis.loadFromCache(); // warm start (usable immediately)
      await chassis.build(); // reconcile only what changed since the cache
      await chassis.saveToCache();
      chassis.startReconcile(refreshMs());
      // Fetch any missing language servers for this project's languages, in the
      // background — precision "appears" once they're installed.
      void chassis.ensureServers().catch(() => {});
    } catch {
      /* degrade to grep/read */
    }
  })();
  return chassis;
}

/** Gracefully stop a chassis (e.g. when a session is replaced via /continue). */
export async function stopChassis(chassis: Chassis | undefined): Promise<void> {
  if (chassis && chassis instanceof CodeChassis) {
    active.delete(chassis);
  }
  await chassis?.dispose?.();
}

/** Kill any language servers on process exit (best-effort, synchronous). */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const killAll = () => {
    for (const c of active) void c.dispose();
  };
  process.once("exit", killAll);
}
