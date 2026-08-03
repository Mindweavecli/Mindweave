/**
 * shellTools.ts — the model's handle on background shells.
 *
 * run_command moves a long job to the background and returns a shell id; these read
 * its output, stop it, or list what's running. Reads are INCREMENTAL (only new
 * output since last time) — so polling a chatty process doesn't re-spend the whole
 * log each turn.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize } from "./paths.js";
import type { ShellInfo } from "./backgroundShells.js";

export const shellOutput: Tool = {
  name: "shell_output",
  readOnly: true,
  description:
    "Read new output from a background shell (started by run_command). Returns only " +
    "what's been printed since your last check, plus whether it's still running or has " +
    "finished (with its exit code).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "integer", description: "The background shell id (e.g. 1)." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const mgr = ctx.backgroundShells;
    if (!mgr) return { output: "No background shells are available in this context.", summary: "no background shells" };
    const id = toId(args.id);
    if (id === null) return fail("`id` must be a shell number.");

    const res = await mgr.read(id);
    if (!res) return fail(`no background shell #${id}.`);
    const head = statusLine(res.info);
    const body = res.chunk.trim();
    // If it's still running, stop the model polling: the event is pushed to it, so a
    // poll loop is pure waste and reads as spam. But the nudge has to promise the
    // RIGHT event. A server is never told about its own stop, so telling the model it
    // would hear "when it finishes" is a promise the tool does not keep — the same
    // false claim that once had it announcing a report that never arrived.
    const nudge =
      res.info.status !== "running"
        ? ""
        : res.info.notify === "on_failure"
          ? "\n[Still starting. You'll be told automatically once it has come up, and you will NOT be " +
            "told when it later stops — do NOT poll again. End your turn.]"
          : res.info.notify === "never"
            ? "\n[Still running. Nothing about this will be reported to you — do NOT poll again. End your turn.]"
            : "\n[Still running. You'll be notified automatically when it finishes — do NOT poll again. " +
              "End your turn and let the user know you'll report when it's done.]";
    return {
      output: (body ? `${head}\n${body}` : `${head}\n(no new output)`) + nudge,
      summary: `shell #${id} (${res.info.status})`,
    };
  },
};

export const killShell: Tool = {
  name: "kill_shell",
  readOnly: false,
  description: "Stop a running background shell by id (kills the whole process tree).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "integer", description: "The background shell id to stop." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const mgr = ctx.backgroundShells;
    if (!mgr) return fail("no background shells are available in this context.");
    const id = toId(args.id);
    if (id === null) return fail("`id` must be a shell number.");
    const killed = mgr.kill(id);
    return killed
      ? { output: `Stopped background shell #${id}.`, summary: `killed shell #${id}` }
      : { output: `Background shell #${id} wasn't running (already finished, or no such id).`, summary: `shell #${id} not running` };
  },
};

export const listShells: Tool = {
  name: "list_shells",
  readOnly: true,
  description: "List background shells (running and recently finished) with their status.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute(_args, ctx): Promise<ToolResult> {
    const mgr = ctx.backgroundShells;
    const shells = mgr?.list() ?? [];
    if (shells.length === 0) return { output: "No background shells.", summary: "no background shells" };
    return {
      output: shells.map((s) => statusLine(s, ctx)).join("\n"),
      summary: `${mgr!.runningCount()} running, ${shells.length} total`,
    };
  },
};

/**
 * One line describing a shell, including the facts that decide whether anything needs
 * doing about it.
 *
 * `stoppedBy` and `ready` are recorded precisely so the model can answer "is my app
 * up" and "why did it stop" without guessing, so they have to be rendered here — this
 * is the only place it can go looking. Without them every ending reads as `exited 1`,
 * which is the same thing a crash and a user closing a window both produce.
 */
function statusLine(info: ShellInfo, ctx?: ToolContext): string {
  const where = ctx ? ` in ${relativize(ctx, info.cwd)}` : "";
  if (info.status === "running") {
    const secs = Math.round((Date.now() - info.startedAt) / 1000);
    const state = info.notify === "on_failure" ? (info.ready ? "up" : "starting") : "running";
    return `#${info.id} ${state} (${secs}s)${where}: ${info.command}`;
  }
  const verb =
    info.stoppedBy === "user"
      ? "stopped by the user"
      : info.stoppedBy === "agent"
        ? "stopped by you"
        : info.status === "killed"
          ? "killed"
          : // A signalled process reports no exit code, so reading the number gives
            // "exited null" — which is how a stopped app used to describe itself.
            info.signal
            ? `stopped (${info.signal})`
            : `exited ${info.exitCode}`;
  // Whether it ever came up is what separates "the user closed their app" from "it
  // never started", which the exit code alone cannot tell you.
  const cameUp = info.notify === "on_failure" && !info.stoppedBy ? (info.ready ? ", after it had come up" : ", never came up") : "";
  return `#${info.id} ${verb}${cameUp}${where}: ${info.command}`;
}

function toId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
