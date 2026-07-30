/**
 * backgroundShells.test.ts — the background-shell lifecycle: adopt → buffer →
 * complete → one-shot notify (no repeat), incremental reads, and kill. Plus
 * run_command auto-backgrounding on a short timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { BackgroundShells, isInteractiveServerCommand, findRunningDuplicate } from "./backgroundShells.js";
import type { ShellInfo } from "./backgroundShells.js";
import { runCommand } from "./runCommand.js";
import type { ToolContext } from "./types.js";

const NODE = process.execPath;
const IS_WIN = process.platform === "win32";
const DETACH = !IS_WIN;

/**
 * A shell command that runs a node `-e` script, valid in the active shell
 * runCommand uses. PowerShell needs the call operator (`&`) to invoke a quoted
 * executable path; POSIX sh runs the quoted path directly. The script is kept
 * free of quote characters so neither shell mangles it.
 */
function nodeCmd(script: string): string {
  return `${IS_WIN ? "& " : ""}"${NODE}" -e "${script}"`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitUntil(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
}

test("adopt → complete → one-shot notifications (model + UI), no repeat", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('hello'); console.error('world')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node -e print", cwd: process.cwd() });
  assert.equal(info.status, "running");

  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.status, "exited");
  assert.equal(mgr.list()[0]!.exitCode, 0);

  // Model drain: once, with a tail, then never again.
  const drained = await mgr.drainCompleted();
  assert.equal(drained.length, 1);
  assert.match(drained[0]!.tail, /hello/);
  assert.equal((await mgr.drainCompleted()).length, 0);
  assert.equal(mgr.pendingCount(), 0);

  // UI drain: once, then never again.
  assert.equal(mgr.takeUiNotifications().length, 1);
  assert.equal(mgr.takeUiNotifications().length, 0);
  mgr.dispose();
});

test("read returns only NEW output each time", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('first')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const a = await mgr.read(info.id);
  assert.match(a!.chunk, /first/);
  const b = await mgr.read(info.id); // nothing new since last read
  assert.equal(b!.chunk, "");
  mgr.dispose();
});

test("kill stops a running shell", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node sleep", cwd: process.cwd() });
  assert.equal(mgr.runningCount(), 1);
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.kill(info.id), false); // already stopped
  mgr.dispose();
});

test("isInteractiveServerCommand: dev servers vs finite tasks", () => {
  for (const c of ["npm run dev", "pnpm start", "yarn serve", "tauri dev", "npm run tauri dev", "vite", "next dev", "nodemon server.js"]) {
    assert.equal(isInteractiveServerCommand(c), true, `${c} should be interactive`);
  }
  for (const c of ["npm run build", "npm test", "tsc", "vite build", "tauri build", "cargo build", "npm run lint", "git status"]) {
    assert.equal(isInteractiveServerCommand(c), false, `${c} should NOT be interactive`);
  }
});

test("a dev server exiting cleanly does NOT wake the model, but the UI still sees it", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('vite ready')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 0);
  // The user closed their app — nothing to react to.
  assert.equal(mgr.pendingCount(), 0);
  assert.equal((await mgr.drainCompleted()).length, 0);
  // But the stop is still visible in the chat.
  assert.equal(mgr.takeUiNotifications().length, 1);
  mgr.dispose();
});

test("a killed dev server does NOT wake the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "tauri dev", cwd: process.cwd() });
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.pendingCount(), 0);
  mgr.dispose();
});

test("a dev server that CRASHES (non-zero) still wakes the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 1);
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainCompleted()).length, 1);
  mgr.dispose();
});

test("a finite task (build) exiting cleanly still wakes the model to report", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('built ok')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run build", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainCompleted()).length, 1);
  mgr.dispose();
});

test("run_command moves a slow command to the background instead of killing it", async () => {
  const mgr = new BackgroundShells();
  const ctx: ToolContext = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr };
  // Sleeps ~3s, but we only wait 1s inline → it should background, not die.
  const res = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 3000)"), timeout: 1000 },
    ctx,
  );
  assert.ok(!res.isError);
  assert.match(res.output, /moved to the background as shell #\d+/);
  assert.equal(mgr.runningCount(), 1); // still alive

  // And it finishes on its own, then notifies once.
  await waitUntil(() => mgr.running().length === 0, 8000);
  const drained = await mgr.drainCompleted();
  assert.equal(drained.length, 1);
  mgr.dispose();
});

// ── Fix C: don't launch a server that's already running ──

function shell(id: number, command: string): ShellInfo {
  return { id, command, cwd: "/p", status: "running", exitCode: null, startedAt: 0, finishedAt: null };
}

test("findRunningDuplicate: matches the same server command (ignoring whitespace/case)", () => {
  const running = [shell(2, "npm run tauri dev")];
  assert.equal(findRunningDuplicate(running, "npm  run   tauri dev")?.id, 2);
  assert.equal(findRunningDuplicate(running, "NPM RUN TAURI DEV")?.id, 2);
});

test("findRunningDuplicate: distinct servers do not collide", () => {
  const running = [shell(2, "npm run dev"), shell(3, "cargo run")];
  assert.equal(findRunningDuplicate(running, "npm run build"), undefined);
  assert.equal(findRunningDuplicate(running, "vite preview"), undefined);
  // But an exact repeat of one of them is caught.
  assert.equal(findRunningDuplicate(running, "cargo run")?.id, 3);
});

test("findRunningDuplicate: nothing running means nothing to collide with", () => {
  assert.equal(findRunningDuplicate([], "npm run tauri dev"), undefined);
});
