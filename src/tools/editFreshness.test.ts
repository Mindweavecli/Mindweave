/**
 * editFreshness.test.ts — editing against a file that moved under you.
 *
 * The situation was never unsafe: an edit is matched against the file's CURRENT bytes, so
 * a stale `old_string` simply fails to match. It was mis-DIAGNOSED. The model was told
 * "old_string not found, copy the target text precisely", which reads as "you mistyped",
 * so the sensible response to that message — retype it more carefully — is exactly the
 * one that cannot work. Naming the real cause is what makes the recovery correct.
 *
 * The quieter case these tests also pin: when the external change lands somewhere the
 * model is NOT editing, the old code applied the edit cleanly against content nobody had
 * looked at. That is the only path where a confident edit rests on a stale understanding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFile } from "./editFile.js";
import { multiEdit } from "./multiEdit.js";
import { changedSinceRead } from "./editTarget.js";
import type { ToolContext } from "./types.js";

const SOURCE = `import logging


def handler(request):
    ip = request.META.get("REMOTE_ADDR")
    return ip


def other(request):
    return 42
`;

async function project(): Promise<{ root: string; path: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "mw-fresh-"));
  const path = join(root, "app.py");
  await fs.writeFile(path, SOURCE);
  const st = await fs.stat(path);
  const reads = new Map([[path, { mtimeMs: st.mtimeMs, size: st.size, full: true }]]);
  return { root, path, ctx: { cwd: root, roots: [root], reads, todos: [] } as unknown as ToolContext };
}

/** Rewrite the file the way a formatter or another process would. */
async function externallyChange(path: string, body: string): Promise<void> {
  // Push the timestamp clearly past the recorded one; some filesystems are coarse.
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path, body);
  const t = new Date(Date.now() + 2000);
  await fs.utimes(path, t, t);
}

test("changedSinceRead needs BOTH signals, because either alone misses real cases", () => {
  // Same size, different mtime: a rename, a flipped boolean, a changed constant.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 9000, size: 500 }), true);
  // Same mtime, different size: coarse filesystem timestamps hide a fast rewrite.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 1000, size: 640 }), true);
  // Untouched.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 1000, size: 500 }), false);
  // Sub-millisecond jitter is not a change; refusing on it would block ordinary edits.
  assert.equal(changedSinceRead({ mtimeMs: 1000.4, size: 500 }, { mtimeMs: 1000.9, size: 500 }), false);
  // A record with no bookkeeping is trusted rather than blocked on our own gap.
  assert.equal(changedSinceRead({}, { mtimeMs: 9000, size: 640 }), false);
});

test("an edit after an external change is refused, and says WHY", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));

  const r = await editFile.execute(
    { path: "app.py", old_string: '    ip = request.META.get("REMOTE_ADDR")', new_string: "    ip = client_ip(request)" },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /changed on disk since you read it/);
  assert.match(r.output, /Read it again/, "the recovery has to be named, or it retypes the same string");
  assert.ok(!/old_string not found/.test(r.output), "the old message sent it down the wrong path");
});

test("the refusal is quiet — it is the agent's own bookkeeping, not the user's problem", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  const r = await editFile.execute({ path: "app.py", old_string: "return 42", new_string: "return 44" }, ctx);
  assert.equal(r.quiet, true);
});

test("the dangerous case: a change ELSEWHERE no longer slips through", async () => {
  // The edit's own target still matches perfectly here, so before this gate the write
  // went ahead — against a file whose other half the model had never seen.
  const { root, path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("def other(request):\n    return 42", "def other(request):\n    raise RuntimeError('gone')"));

  const r = await editFile.execute(
    { path: "app.py", old_string: '    ip = request.META.get("REMOTE_ADDR")', new_string: "    ip = client_ip(request)" },
    ctx,
  );
  assert.ok(r.isError, "the edit matched, but the file is not what the model thinks it is");
  assert.match(r.output, /changed on disk/);
  const after = await readFile(path, "utf8");
  assert.ok(!after.includes("client_ip"), "nothing was written");
  assert.ok(after.includes("RuntimeError"), "and the external change is intact");
});

test("multi_edit is gated the same way — the check lives in the shared gauntlet", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  const r = await multiEdit.execute(
    { path: "app.py", edits: [{ old_string: "import logging", new_string: "import logging\nimport os" }] },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /changed on disk/);
});

test("re-reading clears it, and the edit then goes through", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  // What read_file does: refresh the ledger from the file's current state.
  const st = await fs.stat(path);
  ctx.reads.set(path, { mtimeMs: st.mtimeMs, size: st.size, full: true });

  const r = await editFile.execute({ path: "app.py", old_string: "return 43", new_string: "return 44" }, ctx);
  assert.ok(!r.isError, r.output);
  assert.match(await readFile(path, "utf8"), /return 44/);
});

test("the agent's OWN writes never trip the gate", async () => {
  // recordWrite re-stats after every edit. If it did not, the second edit of any pair
  // would refuse, which would make the whole gate unusable.
  const { path, ctx } = await project();
  const first = await editFile.execute({ path: "app.py", old_string: "return 42", new_string: "return 43" }, ctx);
  assert.ok(!first.isError, first.output);
  const second = await editFile.execute({ path: "app.py", old_string: "return 43", new_string: "return 44" }, ctx);
  assert.ok(!second.isError, second.output);
  assert.match(await readFile(path, "utf8"), /return 44/);
});
