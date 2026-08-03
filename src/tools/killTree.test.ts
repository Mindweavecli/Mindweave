/**
 * killTree.test.ts — the property that makes exit-handler teardown work.
 *
 * `killTreeSync` exists because Node runs no async work during `process.exit`,
 * so a kill that spawns `taskkill` asynchronously never reaches the OS and the
 * server survives. The guarantee under test is therefore not "the process dies
 * eventually" but "the process is dead by the time the call RETURNS", with no
 * awaiting in between — that is the only thing an exit handler can rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killTree, killTreeSync } from "./killTree.js";

const IS_WINDOWS = process.platform === "win32";

/** A long-lived child we can try to kill. */
function longLivedChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("killTreeSync has killed the process by the time it returns", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await sleep(400); // let it actually start
  assert.ok(alive(child.pid), "child should be running before the kill");

  killTreeSync(child.pid);

  // No await here on purpose: an exit handler gets nothing after this line.
  assert.equal(alive(child.pid), false, "killTreeSync must block until the process is gone");
});

test("killTree kills the process, just not synchronously", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await sleep(400);
  assert.ok(alive(child.pid));

  killTree(child.pid);
  await sleep(1500); // the async variant needs an event loop to finish the job

  assert.equal(alive(child.pid), false, "killTree should still kill, given time");
});

test("both variants tolerate a missing pid rather than throwing", () => {
  assert.doesNotThrow(() => killTree(undefined));
  assert.doesNotThrow(() => killTreeSync(undefined));
  // A pid that cannot exist: the caller races process death constantly, so this
  // has to be a no-op rather than an exception on a teardown path.
  assert.doesNotThrow(() => killTreeSync(0x7ffffff0));
});

test("killTreeSync reaps a shelled tree, not just the wrapper", { timeout: 30_000 }, async (t) => {
  if (!IS_WINDOWS) {
    t.skip("shell-shim orphaning is the Windows spawn path");
    return;
  }
  // The shape npm-installed language servers arrive in: a shell wrapper whose
  // real work is a grandchild. Killing the handle alone leaves the grandchild.
  const wrapper = spawn(`node -e "setInterval(()=>{},1000)"`, {
    stdio: "ignore",
    windowsHide: true,
    shell: true,
  });
  await sleep(800);
  const wrapperPid = wrapper.pid!;

  const { execSync } = await import("node:child_process");
  const kids = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${wrapperPid} } | Select-Object -ExpandProperty ProcessId"`,
    { encoding: "utf8" },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  assert.ok(kids.length > 0, "the shell wrapper should have a real child to orphan");

  killTreeSync(wrapperPid);

  const survivors = kids.filter(alive);
  assert.deepEqual(survivors, [], `orphaned descendants after killTreeSync: ${survivors.join(", ")}`);
});
