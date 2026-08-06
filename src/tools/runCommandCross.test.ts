/**
 * runCommandCross.test.ts — the run_command behaviours that must hold on EVERY
 * platform, run on every platform.
 *
 * WHY THIS FILE EXISTS. The run_command suite was 15 tests, every one of them
 * `{ skip: !IS_WINDOWS }`. Not because the behaviour was Windows-only — a command
 * running, `cd` persisting, an abort landing, a slow command moving to the
 * background are all platform-agnostic contracts — but because each test was written
 * with a Windows command string in it. The effect was that macOS and Linux ran the
 * whole suite green while testing none of the most dangerous subsystem in the
 * project: the one that spawns and kills processes.
 *
 * The fix is a tiny per-platform vocabulary. Each entry is the SAME action spelled
 * for the local shell, so the assertions below are about behaviour and never about
 * a dialect. Anything genuinely Windows-only (the `cmd` shell option, the PowerShell
 * parse-error gate) stays in runCommandShell.test.ts, correctly gated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./runCommand.js";
import { BackgroundShells } from "./backgroundShells.js";
import type { ToolContext } from "./types.js";

const IS_WINDOWS = process.platform === "win32";

/** The same handful of actions, spelled for whichever shell is local. */
const SH = IS_WINDOWS
  ? {
      echo: (s: string) => `Write-Output ${s}`,
      exitWith: (n: number) => `exit ${n}`,
      cd: (dir: string) => `Set-Location "${dir}"`,
      sleepLong: "Start-Sleep -Seconds 30",
      sleepMedium: "Start-Sleep -Seconds 10",
    }
  : {
      echo: (s: string) => `echo ${s}`,
      exitWith: (n: number) => `exit ${n}`,
      cd: (dir: string) => `cd "${dir}"`,
      sleepLong: "sleep 30",
      sleepMedium: "sleep 10",
    };

const ctx = (cwd: string): ToolContext => ({ cwd, reads: new Map(), todos: [] }) as unknown as ToolContext;

function withMgr(): { c: ToolContext; mgr: BackgroundShells } {
  const mgr = new BackgroundShells();
  const c = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  return { c, mgr };
}

// ── the basics ────────────────────────────────────────────────────────────────

test("a command runs and its output comes back", async () => {
  const r = await runCommand.execute({ command: SH.echo("hello-cross") }, ctx(process.cwd()));
  assert.match(r.output, /hello-cross/);
  assert.ok(!r.isError, "a successful command is not an error");
});

test("a non-zero exit is surfaced AND flagged isError", async () => {
  // isError is what keeps the verify gate unsatisfied; a failing check that reports
  // success is how a broken build gets called done.
  const r = await runCommand.execute({ command: SH.exitWith(7) }, ctx(process.cwd()));
  assert.equal(r.isError, true);
  assert.match(r.output, /7/);
});

test("cd persists into ctx.cwd, and the session stays on ONE form of the path", async () => {
  // The second half is the macOS bug: run_command reports where it ended up with
  // `pwd -P`, which resolves symlinks, and os.tmpdir() on macOS lives under
  // /private/var. A session that recorded the logical path would compare unequal to
  // its own cwd after this command and quietly leave its own root.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mindweave-cross-cwd-")));
  const c = ctx(process.cwd());
  await runCommand.execute({ command: SH.cd(dir) }, c);
  assert.ok(c.cwd.includes("mindweave-cross-cwd-"), `cwd should have moved into the temp dir, got ${c.cwd}`);
  assert.equal(realpathSync(c.cwd), dir, "the recorded cwd must be the same string form the session uses");
});

// ── interruption ──────────────────────────────────────────────────────────────

test("aborting settles the command fast instead of running it out", { timeout: 20000 }, async () => {
  const controller = new AbortController();
  const c = {
    cwd: process.cwd(),
    reads: new Map(),
    todos: [],
    abortSignal: controller.signal,
  } as unknown as ToolContext;
  const started = Date.now();
  const p = runCommand.execute({ command: SH.sleepMedium }, c);
  setTimeout(() => controller.abort(), 150);
  const r = await p;
  const elapsed = Date.now() - started;
  assert.equal(r.isError, true, "an interrupted command is an error");
  assert.match(r.output, /interrupt/i);
  assert.ok(elapsed < 8000, `should settle right after abort, not run to completion (took ${elapsed}ms)`);
});

test("an already-aborted signal settles immediately", { timeout: 20000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const c = {
    cwd: process.cwd(),
    reads: new Map(),
    todos: [],
    abortSignal: controller.signal,
  } as unknown as ToolContext;
  const r = await runCommand.execute({ command: SH.sleepMedium }, c);
  assert.equal(r.isError, true);
  assert.match(r.output, /interrupt/i);
});

// ── the hang safety nets ──────────────────────────────────────────────────────

test("a slow command is MOVED to the background rather than hanging the turn", { timeout: 20000 }, async () => {
  const { c, mgr } = withMgr();
  const started = Date.now();
  const r = await runCommand.execute({ command: SH.sleepLong, timeout: 1000 }, c);
  const elapsed = Date.now() - started;
  mgr.dispose();
  assert.match(r.output, /background as shell #\d+/i, `expected a backgrounded result, got: ${r.output.slice(0, 120)}`);
  assert.ok(elapsed < 10000, `should return at the ~1s timeout, not run the full command (took ${elapsed}ms)`);
});

test("run_in_background returns a shell id immediately", { timeout: 20000 }, async () => {
  const { c, mgr } = withMgr();
  const r = await runCommand.execute({ command: SH.sleepLong, run_in_background: true }, c);
  mgr.dispose();
  assert.match(r.output, /background as shell #\d+/i);
});

test("with NO background manager the timeout still kills and resolves", { timeout: 20000 }, async () => {
  const c = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as ToolContext;
  const started = Date.now();
  const r = await runCommand.execute({ command: SH.sleepLong, timeout: 1000 }, c);
  const elapsed = Date.now() - started;
  assert.equal(r.isError, true);
  assert.match(r.output, /timed out/i);
  assert.ok(elapsed < 10000, `should resolve at the timeout, not hang (took ${elapsed}ms)`);
});

// ── what the hand-off promises the model ──────────────────────────────────────
// The text has to match what will ACTUALLY happen, and what happens is the same on
// every platform, so this must be checked on every platform.

test("a finite task is told it will be notified", { timeout: 20000 }, async () => {
  const { c, mgr } = withMgr();
  const r = await runCommand.execute({ command: "npm run build", run_in_background: true }, c);
  mgr.dispose();
  assert.match(r.output, /notified AUTOMATICALLY/);
  assert.match(r.output, /report back/);
});

test("a server is told it will NOT hear about the stop, and not to restart it", { timeout: 20000 }, async () => {
  const { c, mgr } = withMgr();
  const r = await runCommand.execute({ command: "npm run dev", run_in_background: true }, c);
  mgr.dispose();
  assert.match(r.output, /WILL be told once it has come up/);
  assert.match(r.output, /will NOT be told when it stops/);
  assert.match(r.output, /never restart it/);
  assert.doesNotMatch(r.output, /notified AUTOMATICALLY the moment it finishes/);
});

// ── the already-running guard ─────────────────────────────────────────────────

test("a second copy of the same command is refused, whatever the command is", { timeout: 30000 }, async () => {
  const { c, mgr } = withMgr();
  // Deliberately not a name any dev-server regex knows: the guard is about identity,
  // not about a list of recognised tools.
  const cmd = SH.sleepLong;
  const first = await runCommand.execute({ command: cmd, run_in_background: true }, c);
  assert.match(first.output, /background as shell #\d+/i);
  const second = await runCommand.execute({ command: cmd, run_in_background: true }, c);
  mgr.dispose();
  assert.match(second.output, /already running/i);
});

// ── the description must not promise what notify does not deliver ─────────────
// This exact lie was fixed once, in the text handed back when a command is
// backgrounded, and survived in the tool description. It cannot fail a test by
// itself: the model simply believes it, tells the user it will report back, and
// then never does.

test("the description does NOT promise unconditional notification", async () => {
  const desc = runCommand.description;
  assert.match(desc, /set by 'notify'/i, "it must point at the parameter that decides");
  assert.match(desc, /only 'on_finish' reports/i, "and say which mode actually reports");
  assert.doesNotMatch(
    desc,
    /you're told when it finishes|you are told when it finishes/i,
    "an unconditional promise is false for 'never' and 'on_failure'",
  );
});

test("a server backgrounded by default is NOT promised a completion report", async () => {
  // The case the description used to get wrong: guessNotifyPolicy sends anything
  // server-shaped to 'on_failure', which reports readiness and never completion.
  const { c, mgr } = withMgr();
  const r = await runCommand.execute({ command: "npm run dev", run_in_background: true }, c);
  mgr.dispose();
  assert.match(r.output, /will NOT be told when it stops/);
  assert.doesNotMatch(r.output, /notified AUTOMATICALLY the moment it finishes/);
});

test("the description no longer claims an inline command can hang the turn", () => {
  // It cannot: the soft timeout backgrounds it. Saying otherwise scared the model
  // away from the feature built for exactly that case.
  const desc = runCommand.description;
  assert.doesNotMatch(desc, /will hang the turn/i);
  assert.match(desc, /not hang the turn/i, "the true cost is the wasted timeout, and it is stated");
});
