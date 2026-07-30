/**
 * attachments.ts — share a file into a message, two ways:
 *
 *   1. `@path`        — type a mention (e.g. `look at @src/foo.ts`).
 *   2. drag & drop    — drag a file from the OS file manager onto the terminal (or
 *                       paste its path). Terminals turn a dropped file into its
 *                       path text — quoted when it has spaces, e.g.
 *                       `"D:\my project\foo.ts"` — which lands in the input buffer.
 *
 * Either way, Mindweave reads the file and hands its FULL contents to the model, while
 * the chat never shows the dump. The model receives an `<attached_file>` block; the
 * human sees a compact chip — a dropped path collapses to just the file name, and
 * one activity note records the line count, e.g. `attached foo.ts (+350 lines)`.
 * The split: the model sees the bytes, the human sees a chip.
 *
 * The split is enforced in two places:
 *   - on send, `resolveAttachments` returns the model text (clean line + file
 *     blocks), the display text (paths collapsed to file names), and the notes;
 *   - on resume, `stripAttachments` hides the file blocks so a reloaded transcript
 *     shows the chip, not the payload.
 *
 * Caps mirror read_file (256 KB / binary refusal): an attachment is a convenience,
 * not a way past the read tool's guards. Binary files (images, etc.) are skipped —
 * the text model can't use them.
 */
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

// Same ceiling as read_file's whole-file read — keep one consistent "too big" line.
const MAX_BYTES = 256 * 1024;

// Image files are recognized so a dropped picture gets a clear "I can't read images"
// message instead of a generic "binary, skipped" error. This is a text model, so the
// image bytes are never sent.
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff", ".avif", ".heic"]);
function isImage(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

// `@token` at a word boundary: `@` after start-or-whitespace, then a path-ish run.
const MENTION_RE = /(^|\s)@([^\s@]+)/g;
// A quoted path — how terminals deliver a dragged file whose path has spaces.
const QUOTED_RE = /'([^']+)'|"([^"]+)"/g;
// A bare absolute path dropped without quotes: Windows drive (`D:\…`), UNC
// (`\\host\…`), or POSIX (`/…`). Must start at a word boundary; stops at
// whitespace or a quote. Real-file gating (below) keeps stray matches harmless.
const BARE_ABS_RE = /(^|\s)((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"']+)/g;

interface Candidate {
  start: number; // index of the token in the source text
  end: number; // index just past the token
  raw: string; // the path text (quotes stripped, trailing punctuation trimmed)
  kind: "mention" | "path"; // mention stays visible; a path collapses to its name
}

export interface ResolvedAttachments {
  /** What the MODEL receives: the clean line plus a block per attached file. */
  modelText: string;
  /** What the CHAT shows: the typed line with dropped paths collapsed to file names. */
  displayText: string;
  /** Compact, human-facing notes (one per resolved/skipped file) — counts, no content. */
  notes: string[];
}

/**
 * Resolve every file reference in `text` (an `@mention`, a quoted path, or a bare
 * absolute path from a drag-and-drop) against `cwd`. A reference that points at a
 * readable text file is attached (full content) and noted with its line count;
 * anything that doesn't resolve to a file is left untouched (so a stray `@`, a
 * quoted phrase, or a `/` in prose never breaks a message). When nothing attaches,
 * `modelText`/`displayText` are the original text unchanged.
 */
export async function resolveAttachments(text: string, cwd: string): Promise<ResolvedAttachments> {
  const candidates = findCandidates(text);
  const seen = new Set<string>();
  const blocks: string[] = [];
  const notes: string[] = [];
  // Spans to collapse in the display line (dropped paths only), applied right-to-left.
  const collapses: { start: number; end: number; label: string }[] = [];

  for (const c of candidates) {
    if (!c.raw) continue;
    const abs = isAbsolute(c.raw) ? resolve(c.raw) : resolve(cwd, c.raw);
    if (seen.has(abs)) continue;

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue; // not a path on disk — leave the text exactly as the user typed it
    }
    if (stat.isDirectory()) continue; // directories aren't attachable (yet)
    seen.add(abs);

    const shown = displayPath(cwd, abs);

    // Images: recognized and acknowledged, but NOT sent (this is a text model).
    if (isImage(abs)) {
      notes.push(`attached image ${shown} (I can't read images — describe it if you need me to know its contents)`);
      blocks.push(
        `[The user shared an image file: ${shown}. Images can't be read by this model, so its ` +
          `contents aren't available to you — ask them to describe it if you need details.]`,
      );
      if (c.kind === "path") collapses.push({ start: c.start, end: c.end, label: basename(abs) });
      continue;
    }

    if (stat.size > MAX_BYTES) {
      notes.push(`skipped ${shown} (${formatBytes(stat.size)} — too large to attach; ask me to read a range)`);
      continue;
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      // Non-image binaries can't be used by a text model — say so plainly.
      notes.push(`skipped ${basename(abs)} (binary file — the model can't read it)`);
      continue;
    }

    const content = buf.toString("utf8");
    const lineCount = content.split("\n").length;
    blocks.push(`<attached_file path="${shown}">\n${content}\n</attached_file>`);
    notes.push(`attached ${shown} (+${lineCount} lines)`);
    // A dropped/quoted path is long and ugly in the chat — collapse it to the file
    // name. An `@mention` is already short, so leave it visible as typed.
    if (c.kind === "path") collapses.push({ start: c.start, end: c.end, label: basename(abs) });
  }

  const displayText = applyCollapses(text, collapses);
  if (blocks.length === 0) return { modelText: text, displayText, notes };
  return { modelText: `${displayText}\n\n${blocks.join("\n\n")}`, displayText, notes };
}

/**
 * Hide attached-file payloads for display. Used when rebuilding the chat from a
 * stored transcript so a resumed session shows the typed line (paths already
 * collapsed), never the re-dumped file body.
 */
export function stripAttachments(content: string): string {
  return content
    .replace(/\n*<attached_file path="[^"]*">\n[\s\S]*?\n<\/attached_file>/g, "")
    .trimEnd();
}

/** Gather every file-reference token (mentions, quoted paths, bare absolute paths),
 *  sorted by position; quoted/bare ranges never overlap (a quote isn't a path char
 *  and bare paths require a leading word boundary). */
function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index! + m[1]!.length;
    out.push({ start, end: start + 1 + m[2]!.length, raw: trimEnds(m[2]!), kind: "mention" });
  }
  for (const m of text.matchAll(QUOTED_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, raw: (m[1] ?? m[2])!, kind: "path" });
  }
  for (const m of text.matchAll(BARE_ABS_RE)) {
    const start = m.index! + m[1]!.length;
    out.push({ start, end: start + m[2]!.length, raw: trimEnds(m[2]!), kind: "path" });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Splice collapse-spans into shorter labels, right-to-left so earlier indices hold. */
function applyCollapses(text: string, spans: { start: number; end: number; label: string }[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.label + out.slice(s.end);
  }
  return out;
}

/** Trim sentence punctuation a path token shouldn't end with: `foo.ts,` → `foo.ts`. */
function trimEnds(s: string): string {
  return s.replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Path relative to cwd when it sits beneath it (reads naturally), else absolute. */
function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..")) return abs;
  return rel.split("\\").join("/");
}

/** A NUL byte in the first chunk is a cheap, reliable "not text" signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
