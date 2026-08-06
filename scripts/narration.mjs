/**
 * narration.mjs — measure how much a session TALKS versus how much it DOES.
 *
 * Dev instrument, not shipped: `scripts/` is outside tsconfig's `include`, so nothing
 * here reaches `dist/`. It exists because "the agent is too verbose" is not something
 * you can act on — you cannot tell whether a prompt change helped without a number, and
 * the number has to come from a real session rather than a pasted excerpt.
 *
 * Three measures, because each one hides a different failure:
 *
 *   PROSE PER TOOL CALL   the headline. The house rule is one or two sentences between
 *                         tool calls, so this is that rule expressed as a number.
 *
 *   OVER-BUDGET %         the share of blocks longer than two sentences. An average
 *                         hides shape: ten terse steps and one 25-line essay average
 *                         out fine and read terribly.
 *
 *   RE-DERIVATION         code identifiers named in 3+ separate blocks — a decision
 *                         being worked out over and over. The verbatim-phrase measure
 *                         does NOT catch this: re-derivation is paraphrased, so it
 *                         scored 4% on a session that visibly repeats itself, while
 *                         this scored 10 identifiers with `importData` in 10 blocks.
 *                         What recurs is the SUBJECT, not the wording.
 *
 * Usage:
 *   node scripts/narration.mjs                            # newest session anywhere
 *   node scripts/narration.mjs <path.jsonl>               # one session
 *   node scripts/narration.mjs --project /path/to/repo    # newest for one project
 */
import { promises as fsp, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ── pure scoring ──────────────────────────────────────────────────────────────

function stripCode(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ");
}

/** Split prose into sentences. Blunt on purpose — we want an order of magnitude. */
export function sentences(text) {
  return stripCode(text)
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*\d])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** Code identifiers named in prose: camelCase or snake_case, 4+ chars. Pure. */
export function identifiers(text) {
  const pattern = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*|_[A-Za-z0-9_$]+)\b/g;
  const found = stripCode(text).match(pattern) ?? [];
  return [...new Set(found.filter((s) => s.length > 3))];
}

/** Content-bearing phrases: n-word shingles. Pure. */
export function shingles(text, n = 4) {
  const words = stripCode(text)
    .toLowerCase()
    .replace(/[^a-z0-9_.$/]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

/** Map each key to the set of block indexes it appears in. Pure. */
function blockIndex(blocks, extract) {
  const map = new Map();
  blocks.forEach((block, i) => {
    for (const key of new Set(extract(block))) {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(i);
    }
  });
  return map;
}

/** Score one session's assistant prose. Pure — records in, numbers out. */
export function scoreSession(records) {
  const assistant = records.filter((r) => r.role === "assistant");
  const blocks = assistant
    .map((r) => (typeof r.content === "string" ? r.content.trim() : ""))
    .filter((c) => c.length > 0);
  const toolCalls = assistant.reduce((n, r) => n + (Array.isArray(r.toolCalls) ? r.toolCalls.length : 0), 0);

  const proseChars = blocks.reduce((n, c) => n + c.length, 0);
  const perBlock = blocks.map((b) => sentences(b).length);
  const overBudget = perBlock.filter((n) => n > 2).length;

  const phraseIn = blockIndex(blocks, (b) => shingles(b));
  const repeated = [...phraseIn.values()].filter((where) => where.size > 1).length;

  const identIn = blockIndex(blocks, (b) => identifiers(b));
  const churned = [...identIn.entries()]
    .filter(([, where]) => where.size >= 3)
    .sort((a, b) => b[1].size - a[1].size);

  return {
    turns: records.filter((r) => r.role === "user").length,
    blocks: blocks.length,
    toolCalls,
    proseChars,
    proseCharsPerToolCall: toolCalls ? Math.round(proseChars / toolCalls) : proseChars,
    medianSentences: median(perBlock),
    maxSentences: perBlock.length ? Math.max(...perBlock) : 0,
    overBudgetBlocks: overBudget,
    overBudgetPct: blocks.length ? Math.round((overBudget / blocks.length) * 100) : 0,
    repetitionPct: phraseIn.size ? Math.round((repeated / phraseIn.size) * 100) : 0,
    rederivedIdents: churned.length,
    worstChurn: churned.slice(0, 5).map(([id, where]) => `${id} in ${where.size}`),
    approxProseTokens: Math.round(proseChars / 3.5),
  };
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ── session lookup + CLI ──────────────────────────────────────────────────────

/** Mirrors memory/store.ts sanitizeProjectPath. Duplicated so this keeps working
 *  against sessions written by an older build. */
function sanitizeProjectPath(p) {
  return p.replace(/[/\\:]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Entries of a directory, or [] if it is absent. Anything else is reported — a
 *  swallowed error here reads as "no sessions", which is the wrong answer to show. */
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    return [];
  }
}

function newestIn(dir) {
  return listDir(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

function newestAnywhere() {
  const base = join(homedir(), ".mindweave", "projects");
  if (!existsSync(base)) return undefined;
  return listDir(base)
    .map((p) => newestIn(join(base, p)))
    .filter(Boolean)
    .map((p) => ({ path: p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

async function readSession(path) {
  const raw = await fsp.readFile(path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partial trailing write is normal on a live session */
    }
  }
  return out;
}

function report(label, s) {
  console.log(`\n${label}`);
  console.log(`  user turns .............. ${s.turns}`);
  console.log(`  tool calls .............. ${s.toolCalls}`);
  console.log(`  prose blocks ............ ${s.blocks}`);
  console.log(`  PROSE PER TOOL CALL ..... ${s.proseCharsPerToolCall} chars`);
  console.log(`  sentences/block ......... median ${s.medianSentences}, worst ${s.maxSentences}`);
  console.log(`  OVER BUDGET (>2 sent.) .. ${s.overBudgetBlocks}/${s.blocks} blocks (${s.overBudgetPct}%)`);
  console.log(`  RE-DERIVATION ........... ${s.rederivedIdents} identifiers named in 3+ blocks`);
  if (s.worstChurn.length) console.log(`                            worst: ${s.worstChurn.join(", ")}`);
  console.log(`  verbatim repetition ..... ${s.repetitionPct}%`);
  console.log(`  total prose ............. ${s.proseChars} chars (~${s.approxProseTokens} tokens)`);
  console.log("\n  Target: one or two sentences between tool calls");
  console.log("  → prose/tool-call ~120-260 chars, over-budget under 25%, re-derivation near 0\n");
}

async function main() {
  const args = process.argv.slice(2);
  const target =
    args[0] === "--project" && args[1]
      ? newestIn(join(homedir(), ".mindweave", "projects", sanitizeProjectPath(args[1])))
      : args[0]
        ? args[0]
        : newestAnywhere();

  if (!target) {
    console.error("No session found. Pass a .jsonl path, or --project <cwd>.");
    process.exit(1);
  }
  report(target, scoreSession(await readSession(target)));
}

// Only run when invoked directly, so the scorer can be imported and tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
