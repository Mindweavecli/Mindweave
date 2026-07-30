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
    // If it's still running, tell the model to stop polling — the completion is pushed
    // to it automatically, so a poll loop is pure waste (and reads as spam to the user).
    const stillRunning = res.info.status === "running";
    const nudge = stillRunning
      ? "\n[Still running. You'll be notified automatically when it finishes — do NOT poll again. " +
        "End your turn and let the user know you'll report when it's ready.]"
      : "";
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

function statusLine(info: ShellInfo, ctx?: ToolContext): string {
  const where = ctx ? ` in ${relativize(ctx, info.cwd)}` : "";
  if (info.status === "running") {
    const secs = Math.round((Date.now() - info.startedAt) / 1000);
    return `#${info.id} running (${secs}s)${where}: ${info.command}`;
  }
  const verb = info.status === "killed" ? "killed" : `exited ${info.exitCode}`;
  return `#${info.id} ${verb}${where}: ${info.command}`;
}

function toId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
