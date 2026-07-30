/**
 * tools.test.ts — behaviour tests for the Step 4 tools.
 *
 * Run with `npm test`. Uses Node's built-in test runner (no extra deps). Each
 * test works in a throwaway temp directory and drives tools exactly as the
 * engine does: `tool.execute(args, ctx)`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { editFile, numberedWindow } from "./editFile.js";
import { runCommand } from "./runCommand.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listDir } from "./listDir.js";
import { protectedPathReason, catastrophicCommandReason } from "./guard.js";

function freshCtx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-test-"));
  return { cwd: dir, reads: new Map(), todos: [] };
}

// ── read_file ─────────────────────────────────────────────────────────────
test("read_file caps a default read at the line limit and says there's more", async () => {
  const ctx = freshCtx();
  const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "big.txt"), lines);
  const r = await readFile.execute({ path: "big.txt" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /showing lines 1-2000 of 2500/);
  assert.doesNotMatch(r.output, /\bL2001\b/); // line 2001 wasn't sent
});

test("read_file dedups an unchanged re-read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  const again = await readFile.execute({ path: "c.txt" }, ctx);
  assert.match(again.output, /unchanged since you last read/);
});

test("read_file re-reads (no dedup) after the file changes", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta gamma"); // different size
  const again = await readFile.execute({ path: "c.txt" }, ctx);
  assert.doesNotMatch(again.output, /unchanged/);
  assert.match(again.output, /beta gamma/);
});

// ── write_file ────────────────────────────────────────────────────────────
test("write_file creates a new file and records it as read", async () => {
  const ctx = freshCtx();
  const r = await writeFile.execute({ path: "a/b.txt", content: "hello" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "a/b.txt"), "utf8"), "hello");
  // recorded → a later edit is allowed without a separate read
  assert.ok(ctx.reads.has(join(ctx.cwd, "a/b.txt")));
});

test("write_file preserves an existing file's CRLF line endings", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "page.html"), "<a>\r\n<b>\r\n");
  await readFile.execute({ path: "page.html" }, ctx);
  await writeFile.execute({ path: "page.html", content: "<x>\n<y>\n<z>\n" }, ctx); // model emits LF
  const after = await fs.readFile(join(ctx.cwd, "page.html"), "utf8");
  assert.equal(after, "<x>\r\n<y>\r\n<z>\r\n");
});

test("write_file matches a sibling's CRLF for a new file in the same dir", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "home.html"), "<h>\r\n<i>\r\n"); // CRLF sibling
  await writeFile.execute({ path: "cart.html", content: "<p>\n<q>\n" }, ctx);
  const after = await fs.readFile(join(ctx.cwd, "cart.html"), "utf8");
  assert.equal(after, "<p>\r\n<q>\r\n");
});

test("write_file defaults a brand-new file to LF when there's no sibling", async () => {
  const ctx = freshCtx();
  await writeFile.execute({ path: "fresh/only.txt", content: "a\nb\n" }, ctx);
  const after = await fs.readFile(join(ctx.cwd, "fresh/only.txt"), "utf8");
  assert.equal(after, "a\nb\n");
});

test("write_file refuses to overwrite an unread existing file", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "x.txt"), "old");
  const r = await writeFile.execute({ path: "x.txt", content: "new" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /hasn't been read/);
  assert.equal(await fs.readFile(join(ctx.cwd, "x.txt"), "utf8"), "old"); // untouched
});

test("write_file overwrites after the file has been read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "x.txt"), "old");
  await readFile.execute({ path: "x.txt" }, ctx);
  const r = await writeFile.execute({ path: "x.txt", content: "new" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "x.txt"), "utf8"), "new");
});

test("write_file refuses a protected path", async () => {
  const ctx = freshCtx();
  const r = await writeFile.execute({ path: ".env", content: "SECRET=1" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /Refusing/);
});

// ── edit_file ─────────────────────────────────────────────────────────────
test("edit_file refuses to edit a file that wasn't read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  const r = await editFile.execute({ path: "c.txt", old_string: "alpha", new_string: "ALPHA" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /has not been read/);
});

test("edit_file errors when old_string is not found", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "zzz", new_string: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /not found/);
});

test("edit_file errors on an ambiguous (multi) match without replace_all", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "x x x");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "x", new_string: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /matches 3 places/);
});

test("edit_file replaces a unique match", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "beta", new_string: "GAMMA" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "alpha GAMMA");
});

test("edit_file matches a multi-line old_string against a CRLF file (LF from the model)", async () => {
  const ctx = freshCtx();
  // A Windows-style file on disk (CRLF). The model, shown LF lines by read_file,
  // sends an LF old_string. This used to fail every time ("old_string not found").
  const onDisk = ".section h2 {\r\n    font-size: 30px;\r\n}\r\n";
  await fs.writeFile(join(ctx.cwd, "style.css"), onDisk);
  await readFile.execute({ path: "style.css" }, ctx);
  const r = await editFile.execute(
    {
      path: "style.css",
      old_string: ".section h2 {\n    font-size: 30px;\n}", // LF, as the model would send
      new_string: ".section h2 {\n    font-size: 28px;\n}",
    },
    ctx,
  );
  assert.equal(r.isError, undefined, r.output);
  const after = await fs.readFile(join(ctx.cwd, "style.css"), "utf8");
  assert.match(after, /font-size: 28px;/);
  assert.ok(after.includes("\r\n"), "the file's CRLF line endings are preserved");
  assert.ok(!after.includes("\r\r"), "no doubled carriage returns");
});

test("edit_file handles a `$` in the replacement literally", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "price here");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "price here", new_string: "$9.99 ($&)" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "$9.99 ($&)");
});

test("edit_file replace_all changes every occurrence", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "x x x");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "x", new_string: "y", replace_all: true }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "y y y");
});

test("edit_file returns the changed region with line numbers (so no re-read is needed)", async () => {
  const ctx = freshCtx();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "c.txt"), lines);
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editFile.execute({ path: "c.txt", old_string: "line 10", new_string: "LINE TEN" }, ctx);
  assert.equal(r.isError, undefined, r.output);
  // The window shows the edited line, numbered, with surrounding context.
  assert.match(r.output, /10  LINE TEN/);
  assert.match(r.output, /\b8  line 8/); // a few lines of context above
  assert.doesNotMatch(r.output, /\b1  line 1\b/); // far-away lines are not included
});

test("numberedWindow numbers the spanned lines plus padding, bounded by maxLines", () => {
  const text = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
  const startChar = text.indexOf("d");
  const w = numberedWindow(text, startChar, startChar + 1, 1); // pad=1 around line 4
  assert.equal(w, ["3  c", "4  d", "5  e"].join("\n"));

  const many = Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n");
  const capped = numberedWindow(many, 0, many.length, 4, 10);
  assert.equal(capped.split("\n").length, 11); // 10 lines + the truncation marker
  assert.match(capped, /region continues/);
});

// ── glob / grep / list_dir ──────────────────────────────────────────────────
async function seed(ctx: ToolContext) {
  await fs.mkdir(join(ctx.cwd, "src"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "src/a.ts"), "export const a = 1;\n// TODO: fix\n");
  await fs.writeFile(join(ctx.cwd, "src/b.ts"), "export const b = 2;\n");
  await fs.writeFile(join(ctx.cwd, "readme.md"), "# hi\nTODO later\n");
  await fs.mkdir(join(ctx.cwd, "node_modules/pkg"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "node_modules/pkg/index.ts"), "TODO ignored\n");
}

test("glob matches by pattern and skips ignored dirs", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.match(r.output, /src\/b\.ts/);
  assert.doesNotMatch(r.output, /node_modules/); // ignored
});

test("grep content mode finds matches with locations, ignoring node_modules", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepTool.execute({ pattern: "TODO", output_mode: "content" }, ctx);
  assert.match(r.output, /src\/a\.ts:2:/);
  assert.match(r.output, /readme\.md:2:/);
  assert.doesNotMatch(r.output, /node_modules/);
});

test("grep files_with_matches lists only matching files", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepTool.execute({ pattern: "export const", glob: "*.ts" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.match(r.output, /src\/b\.ts/);
  assert.doesNotMatch(r.output, /readme\.md/);
});

test("grep reports an invalid regex instead of throwing", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepTool.execute({ pattern: "(" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /invalid regular expression/);
});

test("list_dir shows directories first with a trailing slash", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /src\//);
  assert.match(r.output, /readme\.md/);
});

// ── run_command ─────────────────────────────────────────────────────────────
test("run_command runs a command and returns its output", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "echo mindweave123" }, ctx);
  assert.match(r.output, /mindweave123/);
});

test("run_command reports a non-zero exit code", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "exit 3" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /code 3/);
});

test("run_command persists cwd across calls (cd carries over)", async () => {
  const ctx = freshCtx();
  await fs.mkdir(join(ctx.cwd, "sub"), { recursive: true });
  await runCommand.execute({ command: "cd sub" }, ctx);
  assert.match(ctx.cwd.split("\\").join("/"), /\/sub$/);
});

test("run_command refuses a catastrophic command", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "rm -rf /" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /Refusing/);
});

// ── guard ───────────────────────────────────────────────────────────────────
test("guard flags protected paths and allows ordinary ones", () => {
  assert.ok(protectedPathReason("/proj/.env"));
  assert.ok(protectedPathReason("/proj/.git/config"));
  assert.ok(protectedPathReason("/home/u/.ssh/id_rsa"));
  assert.ok(protectedPathReason("/proj/key.pem"));
  assert.equal(protectedPathReason("/proj/src/index.ts"), null);
});

test("guard flags catastrophic commands and allows ordinary ones", () => {
  assert.ok(catastrophicCommandReason("rm -rf /"));
  assert.ok(catastrophicCommandReason("mkfs.ext4 /dev/sda"));
  assert.equal(catastrophicCommandReason("npm test"), null);
  assert.equal(catastrophicCommandReason("rm -rf ./build"), null); // local dir is fine
});
