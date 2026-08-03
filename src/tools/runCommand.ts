/**
 * runCommand.ts — run a shell command in the project.
 *
 * This is Mindweave's hands on the system: build, test, git, scaffolding. The design
 * carries a few things that make a shell tool genuinely reliable:
 *
 *  - cwd PERSISTS across calls within a turn without a long-lived shell. We spawn a
 *    fresh shell per command, but the command is wrapped to write its final working
 *    directory to a temp file; we read that back into `ctx.cwd`, so a `cd src` in one
 *    call is still in effect for the next command in the same turn. The engine resets
 *    ctx.cwd to the project root at the start of each turn (see respond()), so a stale
 *    `cd` never carries across turns — the project root is the stable contract.
 *  - whole-tree kill on timeout. Killing the shell alone leaves grandchildren
 *    (node → jest, a dev server) holding the output pipe open so it looks hung
 *    forever — so we kill the entire process tree (`taskkill /T` on Windows,
 *    the process group on POSIX).
 *  - wall-clock timeout, 2 min default / 10 min max.
 *  - anti-hang environment: GIT_EDITOR=true and a hidden window stop an
 *    interactive editor or prompt from freezing the turn.
 *
 * The shell is PowerShell on Windows and POSIX sh elsewhere; the system prompt
 * names which, so the model writes commands that will actually run. Deciding
 * WHAT to run is the model's job — this tool only executes it, with one
 * mechanical seatbelt (guard.ts) that refuses a handful of catastrophic,
 * irreversible commands.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { catastrophicCommandReason, sensitiveCommandReason } from "./guard.js";
import { forbiddenCommandReason, forbiddenCommandPatternReason } from "../governor/forbidden.js";
import { requestForbiddenLift } from "./approval.js";
import { killTree } from "./killTree.js";
import { relativize } from "./paths.js";
import { outputDetail } from "./detail.js";
import { powershellLintReason, powershellParseError, powershellReservedAssignmentReason } from "./shellLint.js";
import { findRunningDuplicate, isInteractiveServerCommand } from "./backgroundShells.js";

const IS_WINDOWS = process.platform === "win32";

/** Which shell to run in on Windows. Elsewhere everything is POSIX sh and this is
 *  ignored. PowerShell is the default; cmd is opt-in for cmd.exe-syntax commands. */
type Shell = "powershell" | "cmd";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_OUTPUT_CHARS = 30_000;

/** Human label for the shell, kept in sync with the system prompt. */
export function commandShellLabel(): string {
  return IS_WINDOWS ? "Windows PowerShell" : "the POSIX shell (sh)";
}

export const runCommand: Tool = {
  name: "run_command",
  readOnly: false,
  description:
    `Run a shell command in the project and return its combined output and exit ` +
    `code. The shell is ${commandShellLabel()}. Every turn starts at the project root; ` +
    `the working directory persists between calls WITHIN a turn (so 'cd' carries over ` +
    `mid-turn) but resets to the root next turn. A command still running after 2 minutes ` +
    `(or 'timeout' ms, up to 10) is MOVED TO THE BACKGROUND, not killed — you get a ` +
    `shell id, the session continues, and you're told when it finishes; read its ` +
    `output with shell_output. Pass 'run_in_background: true' to background it from ` +
    `the start (a dev server, a long build/test you don't need to wait on). ` +
    `Write commands for ${commandShellLabel()} (see the shell section of the system prompt)` +
    `${IS_WINDOWS ? "; or pass shell:'cmd' to run in cmd.exe instead (for && / || chaining or cmd-only tools)" : ""}. ` +
    `Prefer Mindweave's read/edit/search tools over shelling out, and never run an interactive or ` +
    `never-terminating command inline (it will hang the turn) — background it instead.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      shell: {
        type: "string",
        enum: ["powershell", "cmd"],
        description:
          "Windows only (ignored elsewhere): which shell to run in. Default 'powershell'. Choose " +
          "'cmd' for commands written in cmd.exe syntax — && / || chaining, or a tool that misbehaves " +
          "under PowerShell — Mindweave runs them as a batch script. Note: in cmd a for-loop uses %%i, and " +
          "cwd may not carry over when the command itself is a .cmd tool (chain in one call instead).",
      },
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        description: `How long to wait inline before moving it to the background, in ms (default 120000, max ${MAX_TIMEOUT_MS}).`,
      },
      run_in_background: {
        type: "boolean",
        description: "Start it in the background immediately and return a shell id (don't wait).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return fail("`command` is required.");

    const blocked = catastrophicCommandReason(command);
    if (blocked) {
      return fail(`Refusing to run this command: it looks like ${blocked}.`);
    }
    // A shell would sidestep every per-file gate the read/write tools enforce.
    const sensitive = sensitiveCommandReason(command);
    if (sensitive) {
      return fail(
        `Refusing to run this command: it would print the contents of ${sensitive} into ` +
          `the conversation. Checking whether the file exists, listing it, or copying it ` +
          `is fine — reading it out is not. If you genuinely need what's inside, use ` +
          `read_file, which asks the user first.`,
      );
    }
    const forbidden = forbiddenCommandReason(ctx.governance?.forbidden, command);
    if (forbidden) {
      const lift = await requestForbiddenLift(
        ctx,
        forbidden,
        "this command",
        `it references '${forbidden}', which the user has forbidden touching.`,
      );
      if (lift) return lift; // refused or deferred; an allow lifts it and falls through
    }
    // Forbidden COMMAND patterns: a command the user said never to run (e.g. `tauri
    // dev`). Deterministic — the model cannot bypass it; only the user can lift it
    // (same approval channel as forbidden paths, session-only).
    const forbiddenCmd = forbiddenCommandPatternReason(ctx.governance?.forbidden, command);
    if (forbiddenCmd) {
      const lift = await requestForbiddenLift(
        ctx,
        forbiddenCmd,
        "this command",
        `the user has forbidden running '${forbiddenCmd}'.`,
        "forbidden command",
      );
      if (lift) return lift;
    }

    let timeout = DEFAULT_TIMEOUT_MS;
    if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
      timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout)));
    }

    const shell: Shell = args.shell === "cmd" ? "cmd" : "powershell";

    // Already-running server guard: don't launch a dev server / app that's already up.
    // Starting a second copy collides on the port, and the model then wastes a long loop
    // fighting the conflict it created. The completion path still reports the live one.
    if (isInteractiveServerCommand(command) && ctx.backgroundShells) {
      const dup = findRunningDuplicate(ctx.backgroundShells.running(), command);
      if (dup) {
        return {
          output:
            `\`${clip(command)}\` is already running in the background as shell #${dup.id}, so I'm not ` +
            `starting a second copy — that would collide on the same port. It's already up; if you want a ` +
            `fresh start, call kill_shell(${dup.id}) first, then relaunch.`,
          isError: true,
          summary: `already running as shell #${dup.id}`,
        };
      }
    }

    // Pre-execution gate: don't waste a run on a guaranteed PowerShell parse error
    // (`&&`/`||`) or an assignment to a read-only automatic variable (`$pid = …`). Catch
    // it here and hand back the fix so the model corrects in one step instead of running,
    // failing, and re-reading the error (the wall that spawned a long flailing loop).
    if (IS_WINDOWS && shell === "powershell") {
      const parseError = powershellParseError(command);
      if (parseError) return fail(parseError);
      const reserved = powershellReservedAssignmentReason(command);
      if (reserved) return fail(reserved);
    }

    return runShell(command, ctx, timeout, args.run_in_background === true, shell);
  },
};

async function runShell(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
  background: boolean,
  shell: Shell,
): Promise<ToolResult> {
  // A unique temp file the wrapped command writes its final cwd into.
  const cwdFile = join(tmpdir(), `mindweave-cwd-${randomBytes(6).toString("hex")}.txt`);
  // Where we stood before the command ran — applyCwd may move ctx.cwd, and the model
  // needs telling when it does (see cwdChangeNote).
  const cwdBefore = ctx.cwd;

  const { bin, args, wrapped, tempFile } = buildInvocation(command, cwdFile, shell);
  const child = spawn(bin, [...args, wrapped], {
    cwd: ctx.cwd,
    env: {
      ...process.env,
      GIT_EDITOR: "true", // never drop into an interactive editor and hang
      GIT_PAGER: "cat",
      PAGER: "cat",
    },
    windowsHide: true,
    // POSIX: own process group so we can kill the whole tree (timeout / kill_shell).
    detached: !IS_WINDOWS,
  });

  const mgr = ctx.backgroundShells;

  // Explicit background: hand off immediately, don't wait for it.
  //
  // The abort listener below is only wired for the FOREGROUND path, so this branch
  // has to check the signal itself. Without it an interrupted turn still adopts the
  // process, and because backgrounding deliberately outlives the turn, Esc would
  // leave a dev server running that the user believed they had cancelled.
  if (background && mgr) {
    if (ctx.abortSignal?.aborted) {
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      return {
        output: "Command interrupted before it started.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      };
    }
    const info = mgr.adopt(child, { command, cwd: ctx.cwd, cwdFile });
    return backgroundedResult(info.id, command, `Started in the background as shell #${info.id}`);
  }

  return new Promise<ToolResult>((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer) => {
      if (truncated) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      if (settled) return;
      // Soft timeout: move the LIVE process to the background (preferred), so a long
      // test/build keeps running instead of being lost. With no manager (bare tests)
      // fall back to the old behavior — kill the tree.
      if (mgr) {
        settled = true;
        detachAbort();
        child.stdout?.off("data", collect);
        child.stderr?.off("data", collect);
        const info = mgr.adopt(child, { command, cwd: ctx.cwd, initial: output, cwdFile });
        resolve(
          backgroundedResult(
            info.id,
            command,
            `Still running after ${Math.round(timeoutMs / 1000)}s — moved to the background as shell #${info.id}`,
          ),
        );
      } else {
        timedOut = true;
        killTree(child.pid);
      }
    }, timeoutMs);

    // Esc / interrupt: if the turn is aborted while this command is still running,
    // kill the whole process tree and settle immediately. Without this a hung command
    // (an installer waiting on a GUI, an interactive prompt) freezes the agent — the
    // engine only re-checks the abort signal BETWEEN steps, never mid-tool-call, so it
    // would stay blocked on this promise forever.
    const signal = ctx.abortSignal;
    const detachAbort = () => signal?.removeEventListener("abort", onAbort);
    function onAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", collect);
      child.stderr?.off("data", collect);
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      const body = output.trim();
      resolve({
        output: body ? `${body}\n\n[interrupted]` : "Command interrupted before it finished.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      });
    }
    if (signal?.aborted) return void onAbort();
    signal?.addEventListener("abort", onAbort);

    const finish = async (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      await applyCwd(cwdFile, ctx);
      if (tempFile) await fs.rm(tempFile, { force: true }).catch(() => {});
      resolve(format(command, ctx, output, truncated, timedOut, exitCode, timeoutMs, shell, cwdBefore));
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      resolve(fail(`could not start the command: ${error.message}`));
    });
    child.on("close", (code) => void finish(code));
  });
}

/** The result returned when a command is (or becomes) a background shell. */
function backgroundedResult(id: number, command: string, lead: string): ToolResult {
  return {
    output:
      `${lead}. It is running in the background and you will be notified AUTOMATICALLY the moment it ` +
      `finishes — so do NOT poll it. Tell the user in ONE short line that it's started and that you'll ` +
      `report back when it's ready, then STOP (end your turn). Only call shell_output(${id}) if you have a ` +
      `specific reason to inspect partial output; use kill_shell(${id}) to stop it.`,
    summary: `bg shell #${id}: ${clip(command)}`,
  };
}

/** Build the shell invocation: which binary, its flags, and the wrapped command. */
function buildInvocation(
  command: string,
  cwdFile: string,
  shell: Shell,
): { bin: string; args: string[]; wrapped: string; tempFile?: string } {
  if (IS_WINDOWS && shell === "cmd") {
    // cmd.exe can't run a multi-line /c string (it executes only the first line), so
    // we materialize a tiny .bat: the command, then capture its exit code and final
    // cwd. Run line-by-line, so `cd` persists and `&&`/`||` chains work natively.
    // ComSpec is the reliable path to cmd.exe (a bare name may not resolve).
    const batFile = join(tmpdir(), `mindweave-run-${randomBytes(6).toString("hex")}.bat`);
    const script =
      `@echo off\r\n` +
      `${command}\r\n` +
      `set __ec=%ERRORLEVEL%\r\n` +
      `cd > "${cwdFile}"\r\n` +
      `exit /b %__ec%`;
    writeFileSync(batFile, script, "utf8");
    return {
      bin: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c"],
      wrapped: batFile,
      tempFile: batFile,
    };
  }
  if (IS_WINDOWS) {
    // After the command, record the final location and preserve its exit code.
    const wrapped =
      `${command}\n` +
      `$__ec = $LASTEXITCODE; if ($null -eq $__ec) { $__ec = 0 }\n` +
      `$PWD.Path | Out-File -FilePath ${psQuote(cwdFile)} -Encoding utf8\n` +
      `exit $__ec`;
    return {
      bin: "powershell.exe",
      // -ExecutionPolicy Bypass (process-scoped only) so the model can actually run
      // npm/npx/tsc/jest — their Windows shims are .ps1 scripts, which a Restricted
      // execution policy blocks ("npm.ps1 cannot be loaded because running scripts is
      // disabled"). Without this the verify/test/build story silently can't run.
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      wrapped,
    };
  }
  const wrapped =
    `${command}\n` +
    `__ec=$?\n` +
    `pwd -P > ${shQuote(cwdFile)} 2>/dev/null\n` +
    `exit $__ec`;
  return { bin: "/bin/sh", args: ["-c"], wrapped };
}

/**
 * The line appended to a command's output when it moved the shell (pure).
 *
 * `cd` persisting across calls within a turn is a real convenience, but it is also
 * invisible: the model composes the next command's relative paths from the project
 * root, because nothing ever told it the floor moved. That produces a doubled path
 * (`code-blue/backend/code-blue/backend/manage.py`), which fails, and looks to the
 * model like the file is missing rather than like it is standing somewhere else.
 *
 * So we say it, once, exactly when it happens. `shown` is the new location relative
 * to the project root — the same form paths are addressed in everywhere else.
 * Returns null when the command did not move, which is nearly every command, so
 * ordinary output is untouched.
 */
export function cwdChangeNote(before: string, after: string, shown: string): string | null {
  if (before === after) return null;
  const where = shown === "." ? "the project root" : shown;
  return (
    `[Working directory is now ${where}. It stays there for the rest of this turn, so ` +
    `relative paths in your next command resolve from ${where}, not from the project root.]`
  );
}

/** Read the cwd the command ended in and adopt it (if it still exists). */
async function applyCwd(cwdFile: string, ctx: ToolContext): Promise<void> {
  try {
    const text = (await fs.readFile(cwdFile, "utf8")).trim();
    if (text) {
      // Confirm it's a real directory before adopting — a half-written file or a
      // deleted dir must not strand the session somewhere invalid.
      const stat = await fs.stat(text);
      if (stat.isDirectory()) ctx.cwd = text;
    }
  } catch {
    // No file / unreadable → command didn't change dir (or failed early); keep cwd.
  } finally {
    await fs.rm(cwdFile, { force: true }).catch(() => {});
  }
}

function format(
  command: string,
  ctx: ToolContext,
  output: string,
  truncated: boolean,
  timedOut: boolean,
  exitCode: number | null,
  timeoutMs: number,
  shell: Shell,
  cwdBefore: string,
): ToolResult {
  const body = output.trim();
  const parts: string[] = [];

  if (timedOut) {
    parts.push(
      `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. ` +
        `If it was a long-running or watching process, run a form that terminates.`,
    );
  } else if (exitCode !== 0 && exitCode !== null) {
    parts.push(`Command exited with code ${exitCode}.`);
  }

  if (body) {
    parts.push(body);
    if (truncated) parts.push("… (output truncated)");
  } else if (!timedOut) {
    parts.push("(no output)");
  }

  // In PowerShell, nudge the model when it wrote a bash-ism that breaks there
  // (advisory only — never blocks; the linter is conservative). Not for cmd, which
  // supports && / || natively.
  if (IS_WINDOWS && shell === "powershell") {
    const lint = powershellLintReason(command);
    if (lint) parts.push(lint);
  }

  const shown = relativize(ctx, ctx.cwd);
  // Did this command move the shell? If so the model must hear it here, in the tool
  // OUTPUT — the summary line below is display-only and never reaches the model.
  const moved = cwdChangeNote(cwdBefore, ctx.cwd, shown);
  if (moved) parts.push(moved);
  const status = timedOut ? "timed out" : exitCode === 0 ? "ok" : `exit ${exitCode}`;
  return {
    output: parts.join("\n"),
    isError: timedOut || (exitCode !== 0 && exitCode !== null),
    summary: `ran \`${clip(command)}\` in ${shown} (${status})`,
    detail: outputDetail(body),
  };
}

/** Single-quote a string for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** Single-quote a string for PowerShell (double any embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.split("'").join("''")}'`;
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
