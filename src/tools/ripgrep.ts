/**
 * ripgrep.ts — run the `rg` binary for fast, precise search.
 *
 * ripgrep is the precise, fast ground-truth scanner: it walks the tree itself
 * (memory-mapped, multithreaded), respects .gitignore, and streams back only
 * matches — the project is never loaded into the agent. We shell out to it and
 * parse the lines.
 *
 * Availability is probed once. When `rg` isn't on the machine, callers fall back
 * to the pure-Node walk (walk.ts) so search still works everywhere — just slower.
 * Point `MINDWEAVE_RIPGREP_PATH` at a binary to override discovery.
 */
import { spawn } from "node:child_process";

const RG = process.env.MINDWEAVE_RIPGREP_PATH || "rg";
const MAX_BUFFER = 20_000_000; // 20 MB — big monorepos can emit a lot of paths
const TIMEOUT_MS = 20_000;

let probe: Promise<boolean> | undefined;

/** True if `rg` is runnable. Probed once and cached for the session. */
export function ripgrepAvailable(): Promise<boolean> {
  if (!probe) {
    probe = new Promise<boolean>((resolve) => {
      try {
        const child = spawn(RG, ["--version"], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
  return probe;
}

export interface RgResult {
  /** stdout split into non-empty lines (CR stripped). */
  lines: string[];
  /** rg exit code: 0 = matches, 1 = no matches, 2 = usage/regex error. */
  code: number | null;
  stderr: string;
  /** True if output hit the buffer cap and was cut. */
  truncated: boolean;
}

/** Run ripgrep with `args`, working from `cwd`. Never throws — failures surface
 *  in the returned code/stderr so the tool can report them cleanly. */
export function runRipgrep(args: string[], cwd: string): Promise<RgResult> {
  return new Promise<RgResult>((resolve) => {
    let out = "";
    let err = "";
    let truncated = false;
    let settled = false;

    const finish = (code: number | null, stderr: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = out
        .split("\n")
        .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
        .filter(Boolean);
      resolve({ lines, code, stderr: stderr.trim(), truncated });
    };

    let child;
    try {
      child = spawn(RG, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ lines: [], code: -1, stderr: String(error), truncated: false });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null, "ripgrep timed out");
    }, TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      if (truncated) return;
      out += d.toString("utf8");
      if (out.length > MAX_BUFFER) {
        out = out.slice(0, MAX_BUFFER);
        truncated = true;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 8192) err += d.toString("utf8");
    });
    child.on("error", () => finish(-1, "ripgrep failed to start"));
    child.on("close", (code) => finish(code, err));
  });
}
