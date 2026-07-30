/**
 * servers.ts — which language server handles which file, and how to obtain it.
 *
 * Resolution order per language: BUNDLED (shipped with Mindweave) → on PATH (you
 * already have it) → INSTALLED in Mindweave's cache → AUTO-INSTALL (fetch it) → none
 * (the file stays on the tree-sitter tier). This single table is where language
 * coverage grows; `provision.ts` does the fetching.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { ensureInstalled, resolveInstalled, type GithubTarget, type InstallSpec } from "./provision.js";

const require = createRequire(import.meta.url);

export interface ServerSpec {
  key: string;
  command: string;
  args: string[];
}

// ── file extension → LSP languageId ───────────────────────────────────────────
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".zig": "zig",
  ".lua": "lua",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shellscript", ".bash": "shellscript",
  ".java": "java",
  ".cs": "csharp",
  ".hs": "haskell",
  ".ex": "elixir", ".exs": "elixir",
  ".ml": "ocaml", ".mli": "ocaml",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sbt": "scala",
  ".dart": "dart",
  ".tf": "terraform",
  ".yaml": "yaml", ".yml": "yaml",
  ".json": "json",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less",
};

export function languageIdFor(absPath: string): string | undefined {
  return EXT_LANG[extname(absPath).toLowerCase()];
}

// ── registry ────────────────────────────────────────────────────────────────
interface Entry {
  key: string;
  langIds: string[];
  /** A server bundled with Mindweave (resolves to a full spec or null). */
  bundled?: () => ServerSpec | null;
  /** Command names to look for on PATH. */
  pathNames?: string[];
  /** Launch args for PATH / installed launches. */
  args: string[];
  /** How to auto-install this server if it isn't otherwise available. */
  install?: InstallSpec;
}

function bundledNode(key: string, modulePath: string, args: string[]): ServerSpec | null {
  try {
    return { key, command: process.execPath, args: [require.resolve(modulePath), ...args] };
  } catch {
    return null;
  }
}

function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext.toLowerCase());
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const npm = (pkg: string, version: string, binName: string): InstallSpec => ({
  source: "npm",
  package: pkg,
  version,
  binName,
});

const github = (repo: string, version: string, targets: Record<string, GithubTarget>): InstallSpec => ({
  source: "github",
  repo,
  version,
  targets,
});

// rust-analyzer ships prebuilt binaries: .zip on Windows (contains the .exe),
// single-file .gz on macOS/Linux (decompresses straight to the binary).
const RUST_ANALYZER = github("rust-lang/rust-analyzer", "2026-06-22", {
  "win32-x64": { asset: "rust-analyzer-x86_64-pc-windows-msvc.zip", bin: "rust-analyzer.exe" },
  "win32-arm64": { asset: "rust-analyzer-aarch64-pc-windows-msvc.zip", bin: "rust-analyzer.exe" },
  "darwin-x64": { asset: "rust-analyzer-x86_64-apple-darwin.gz", bin: "rust-analyzer" },
  "darwin-arm64": { asset: "rust-analyzer-aarch64-apple-darwin.gz", bin: "rust-analyzer" },
  "linux-x64": { asset: "rust-analyzer-x86_64-unknown-linux-gnu.gz", bin: "rust-analyzer" },
  "linux-arm64": { asset: "rust-analyzer-aarch64-unknown-linux-gnu.gz", bin: "rust-analyzer" },
});

// clangd: per-OS .zip; the binary is at clangd_<version>/bin/clangd. The mac build
// is a universal binary (used for both arches); clangd has no arm64-linux build.
const CLANGD = github("clangd/clangd", "22.1.0", {
  "win32-x64": { asset: "clangd-windows-{version}.zip", bin: "clangd_{version}/bin/clangd.exe" },
  "darwin-x64": { asset: "clangd-mac-{version}.zip", bin: "clangd_{version}/bin/clangd" },
  "darwin-arm64": { asset: "clangd-mac-{version}.zip", bin: "clangd_{version}/bin/clangd" },
  "linux-x64": { asset: "clangd-linux-{version}.zip", bin: "clangd_{version}/bin/clangd" },
});

// zls: .zip on Windows, .tar.xz on Unix (system tar extracts xz); binary at root.
const ZLS = github("zigtools/zls", "0.16.0", {
  "win32-x64": { asset: "zls-x86_64-windows.zip", bin: "zls.exe" },
  "win32-arm64": { asset: "zls-aarch64-windows.zip", bin: "zls.exe" },
  "darwin-x64": { asset: "zls-x86_64-macos.tar.xz", bin: "zls" },
  "darwin-arm64": { asset: "zls-aarch64-macos.tar.xz", bin: "zls" },
  "linux-x64": { asset: "zls-x86_64-linux.tar.xz", bin: "zls" },
  "linux-arm64": { asset: "zls-aarch64-linux.tar.xz", bin: "zls" },
});

// lua-language-server: .zip on Windows, .tar.gz on Unix; binary at bin/.
const LUA_LS = github("LuaLS/lua-language-server", "3.18.2", {
  "win32-x64": { asset: "lua-language-server-{version}-win32-x64.zip", bin: "bin/lua-language-server.exe" },
  "darwin-x64": { asset: "lua-language-server-{version}-darwin-x64.tar.gz", bin: "bin/lua-language-server" },
  "darwin-arm64": { asset: "lua-language-server-{version}-darwin-arm64.tar.gz", bin: "bin/lua-language-server" },
  "linux-x64": { asset: "lua-language-server-{version}-linux-x64.tar.gz", bin: "bin/lua-language-server" },
  "linux-arm64": { asset: "lua-language-server-{version}-linux-arm64.tar.gz", bin: "bin/lua-language-server" },
});

const REGISTRY: Entry[] = [
  // Bundled — instant, offline.
  { key: "typescript-language-server", langIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"], args: [],
    bundled: () => bundledNode("typescript-language-server", "typescript-language-server/lib/cli.mjs", ["--stdio"]) },
  { key: "pyright", langIds: ["python"], args: [],
    bundled: () => bundledNode("pyright", "pyright/langserver.index.js", ["--stdio"]) },

  // npm-installable — PATH first, else auto-install via npm.
  { key: "bash-language-server", langIds: ["shellscript"], pathNames: ["bash-language-server"], args: ["start"],
    install: npm("bash-language-server", "5.4.3", "bash-language-server") },
  { key: "intelephense", langIds: ["php"], pathNames: ["intelephense"], args: ["--stdio"],
    install: npm("intelephense", "1.12.6", "intelephense") },
  { key: "yaml-language-server", langIds: ["yaml"], pathNames: ["yaml-language-server"], args: ["--stdio"],
    install: npm("yaml-language-server", "1.15.0", "yaml-language-server") },
  { key: "json-language-server", langIds: ["json"], pathNames: ["vscode-json-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-json-language-server") },
  { key: "html-language-server", langIds: ["html"], pathNames: ["vscode-html-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-html-language-server") },
  { key: "css-language-server", langIds: ["css", "scss", "less"], pathNames: ["vscode-css-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-css-language-server") },

  // PATH-detected (binary servers — GitHub-release auto-install lands in the next
  // phase; toolchain servers like gopls stay PATH-only).
  { key: "gopls", langIds: ["go"], pathNames: ["gopls"], args: [] },
  { key: "rust-analyzer", langIds: ["rust"], pathNames: ["rust-analyzer"], args: [], install: RUST_ANALYZER },
  { key: "clangd", langIds: ["c", "cpp"], pathNames: ["clangd"], args: [], install: CLANGD },
  { key: "zls", langIds: ["zig"], pathNames: ["zls"], args: [], install: ZLS },
  { key: "lua-ls", langIds: ["lua"], pathNames: ["lua-language-server"], args: [], install: LUA_LS },
  { key: "solargraph", langIds: ["ruby"], pathNames: ["solargraph"], args: ["stdio"] },
  { key: "jdtls", langIds: ["java"], pathNames: ["jdtls"], args: [] },
  { key: "csharp-ls", langIds: ["csharp"], pathNames: ["csharp-ls"], args: [] },
  { key: "haskell-ls", langIds: ["haskell"], pathNames: ["haskell-language-server-wrapper"], args: ["--lsp"] },
  { key: "elixir-ls", langIds: ["elixir"], pathNames: ["language_server.sh", "elixir-ls"], args: [] },
  { key: "ocaml-ls", langIds: ["ocaml"], pathNames: ["ocamllsp"], args: [] },
  { key: "sourcekit", langIds: ["swift"], pathNames: ["sourcekit-lsp"], args: [] },
  { key: "kotlin-ls", langIds: ["kotlin"], pathNames: ["kotlin-language-server"], args: [] },
  { key: "metals", langIds: ["scala"], pathNames: ["metals"], args: [] },
  { key: "dart", langIds: ["dart"], pathNames: ["dart"], args: ["language-server"] },
  { key: "terraform-ls", langIds: ["terraform"], pathNames: ["terraform-ls"], args: ["serve"] },
];

const byLang = new Map<string, Entry>();
for (const e of REGISTRY) for (const l of e.langIds) byLang.set(l, e);

// Resolved spec per entry key (cleared by invalidate after an install).
const specCache = new Map<string, ServerSpec | null>();

function resolveEntry(entry: Entry): ServerSpec | null {
  if (entry.bundled) {
    const s = entry.bundled();
    if (s) return s;
  }
  if (entry.pathNames) {
    const found = findOnPath(entry.pathNames);
    if (found) return { key: entry.key, command: found, args: entry.args };
  }
  if (entry.install) {
    const cmd = resolveInstalled(entry.key, entry.install);
    if (cmd) return { key: entry.key, command: cmd, args: entry.args };
  }
  return null;
}

/** The server spec for an LSP languageId, or null if none is available yet. */
export function specForLanguage(langId: string): ServerSpec | null {
  const entry = byLang.get(langId);
  if (!entry) return null;
  if (!specCache.has(entry.key)) specCache.set(entry.key, resolveEntry(entry));
  return specCache.get(entry.key) ?? null;
}

/** The server spec for a file, or null. */
export function serverFor(absPath: string): ServerSpec | null {
  const lang = languageIdFor(absPath);
  return lang ? specForLanguage(lang) : null;
}

/**
 * Auto-install any servers needed for `langIds` that aren't already available.
 * Best-effort and deduped; after a successful install the cache is invalidated so
 * the server resolves on the next query. Called by the alternator in the background.
 */
export async function ensureServers(langIds: Iterable<string>, log?: (m: string) => void): Promise<void> {
  const seen = new Set<string>();
  for (const langId of langIds) {
    const entry = byLang.get(langId);
    if (!entry?.install || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (specForLanguage(langId)) continue; // already available (bundled/PATH/installed)
    const cmd = await ensureInstalled(entry.key, entry.install, log);
    if (cmd) specCache.delete(entry.key); // re-resolve to the freshly installed server
  }
}
