/**
 * webFetch.ts — read a web page.
 *
 * A coding agent constantly needs something off the web: a docs page, a changelog,
 * an RFC, an error explained. Without this the user has to paste it in. The shape
 * is simple: input is a `url` plus an optional `prompt` describing what to pull out.
 *
 * Pipeline: fetch (https-upgraded, timed out, size-capped) → strip to readable
 * markdown (HTML via turndown; text/json/markdown pass through) → if the page is
 * large and the model gave a `prompt`, DISTILL it with one cheap model call so the
 * answer lands in context instead of a giant page; otherwise return the cleaned
 * content (capped). Read-only — touches no files.
 *
 * Model-work boundary: the optional distillation is a model call inside a tool.
 * Its prompt is deliberately thin — "answer this from the page" — no analysis
 * rules baked in; the engineering judgment stays with the model. Degrade-safe: no
 * API key, or any failure, falls back to returning the cleaned/truncated content.
 *
 * Safety: only http/https, and a basic SSRF guard refuses localhost / private-network
 * hosts so the tool can't be pointed at internal services.
 */
import TurndownService from "turndown";
import type { Tool, ToolResult } from "./types.js";
import { toolTurn } from "../dynamo/deepseek.js";

const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_CAP_BYTES = 3_000_000; // stop reading a response past ~3MB
const CONTENT_CAP_CHARS = 12_000; // how much cleaned content we return / distill from
const DISTILL_OVER_CHARS = 12_000; // above this, summarize via a model call (if a prompt is given)

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript", "iframe"]);

export const webFetch: Tool = {
  name: "web_fetch",
  readOnly: true,
  description:
    "Fetch a web page and return its content as readable markdown. Give a `url` and " +
    "optionally a `prompt` describing what to extract — for a large page, the prompt " +
    "is used to return just the relevant answer. Use it to read docs, articles, " +
    "changelogs, or any public URL. http is upgraded to https; private/localhost URLs " +
    "are refused. For GitHub, prefer the gh CLI via run_command when you can.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "The URL to fetch (a fully-formed http(s) URL)." },
      prompt: {
        type: "string",
        description: "Optional: what to extract from the page (used to focus a large page).",
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!rawUrl) return fail("`url` is required.");

    const url = normalizeUrl(rawUrl);
    if (typeof url === "string") return fail(url); // a validation message

    const blocked = ssrfReason(url);
    if (blocked) return fail(blocked);

    const fetched = await fetchUrl(url);
    if (typeof fetched === "string") return fail(fetched);

    const { finalUrl, status, contentType, body } = fetched;

    if (!isTextual(contentType)) {
      return {
        output: `Fetched ${finalUrl} (HTTP ${status}, ${contentType || "unknown type"}). ` +
          `This is binary/non-text content, which web_fetch can't read. ` +
          `If you need it, download it with run_command.`,
        summary: `fetched ${hostOf(url)} (non-text)`,
      };
    }

    let content = contentType.includes("html") ? htmlToMarkdown(body) : body.trim();
    const redirected = hostOf(finalUrl) !== hostOf(url) ? `\n(note: redirected to ${finalUrl})` : "";

    // Large page + a prompt → distill to the answer. Otherwise return content,
    // capped. Distillation is best-effort; failure falls back to truncation.
    if (content.length > DISTILL_OVER_CHARS && prompt) {
      const distilled = await distill(content.slice(0, CONTENT_CAP_CHARS * 3), prompt);
      if (distilled) {
        return {
          output: `From ${finalUrl} (focused on: ${prompt})${redirected}\n\n${distilled}`,
          summary: `fetched ${hostOf(url)} (summarized)`,
        };
      }
    }

    let out = content;
    let truncated = false;
    if (out.length > CONTENT_CAP_CHARS) {
      out = out.slice(0, CONTENT_CAP_CHARS);
      truncated = true;
    }
    const footer = truncated
      ? `\n\n… (content truncated at ${CONTENT_CAP_CHARS} chars; fetch a more specific URL or pass a prompt to focus it)`
      : "";

    return {
      output: `Content of ${finalUrl} (HTTP ${status})${redirected}\n\n${out}${footer}`,
      summary: `fetched ${hostOf(url)} (${out.length} chars${truncated ? ", truncated" : ""})`,
    };
  },
};

// ── fetch ─────────────────────────────────────────────────────────────────────

interface Fetched {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

/** Fetch with timeout + size cap. Returns the body or an error message string. */
async function fetchUrl(url: URL): Promise<Fetched | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mindweave/0.1 (+terminal coding agent)", Accept: "text/html,text/*,application/json;q=0.9,*/*;q=0.8" },
    });
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = await readCapped(res);
    return { finalUrl: res.url || url.toString(), status: res.status, contentType, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return `Timed out fetching ${url.toString()} after ${FETCH_TIMEOUT_MS / 1000}s.`;
    }
    return `Could not fetch ${url.toString()}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body, stopping once past the byte cap. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= DOWNLOAD_CAP_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── transform ───────────────────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // Fall back to a crude tag-strip if turndown chokes on malformed markup.
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

/** One cheap model call to answer `prompt` from the page. null on any failure. */
async function distill(content: string, prompt: string): Promise<string | null> {
  try {
    const { content: answer } = await toolTurn({
      system:
        "You extract information from a web page to answer the user's request. " +
        "Answer only from the content provided; be concise and include relevant " +
        "code or quotes. If the answer isn't present, say so.",
      messages: [{ role: "user", content: `Web page content:\n---\n${content}\n---\n\nRequest: ${prompt}` }],
    });
    return answer.trim() || null;
  } catch {
    return null;
  }
}

// ── url + safety ──────────────────────────────────────────────────────────────

/** Validate, default-to-https, and upgrade http→https. Returns a URL or an error string. */
function normalizeUrl(raw: string): URL | string {
  let text = raw;
  if (!/^[a-z]+:\/\//i.test(text)) text = "https://" + text; // bare host → https
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `Invalid URL: "${raw}".`;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return `Unsupported URL scheme "${url.protocol}" — only http/https.`;
  return url;
}

/** Basic SSRF guard: refuse localhost and private/link-local hosts. */
function ssrfReason(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return `Refusing to fetch a local address (${host}).`;
  }
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return `Refusing to fetch ${host}.`;
  // IPv4 literal in a private/link-local/loopback range.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (isPrivate) return `Refusing to fetch a private/loopback address (${host}).`;
  }
  return null;
}

function isTextual(contentType: string): boolean {
  if (!contentType) return true; // unknown — assume text and let cleanup handle it
  return (
    contentType.includes("text/") ||
    contentType.includes("html") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("markdown")
  );
}

function hostOf(u: string | URL): string {
  try {
    return new URL(u.toString()).hostname;
  } catch {
    return String(u);
  }
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
