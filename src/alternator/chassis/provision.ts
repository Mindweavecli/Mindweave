/**
 * provision.ts — auto-install language servers, Mason-style.
 *
 * When a project uses a language whose server isn't bundled or on PATH, Mindweave
 * fetches it itself into `~/.mindweave/servers/<key>/` and caches it, so precision
 * "just appears" without the user installing anything. Sources mirror how servers
 * are actually distributed:
 *
 *   - npm    — `npm install` into the cache (this is the clean, broad source).
 *   - github — download the OS/arch release asset and extract it (binaries like
 *              rust-analyzer / clangd). [implemented in the next phase]
 *
 * Safety: only the curated, version-pinned registry in servers.ts is ever
 * installed — never an arbitrary package. Best-effort: a failed/blocked install
 * just leaves that language on the tree-sitter tier. Disable with
 * MINDWEAVE_NO_AUTO_INSTALL. In-flight installs are deduped so a language is fetched
 * once per session.
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import AdmZip from "adm-zip";

export interface NpmInstall {
  source: "npm";
  /** Package to install, e.g. "bash-language-server". */
  package: string;
  /** Pinned version. */
  version: string;
  /** The bin shim name the package exposes (in node_modules/.bin). */
  binName: string;
}
export interface GithubTarget {
  /** Release asset filename ("{version}" substituted). */
  asset: string;
  /** Executable path inside the cache dir after extraction ("{version}" substituted). */
  bin: string;
}
export interface GithubInstall {
  source: "github";
  repo: string; // "owner/name"
  version: string; // release tag
  /** platformKey() → which asset to download and where its binary ends up. */
  targets: Record<string, GithubTarget>;
}
export type InstallSpec = NpmInstall | GithubInstall;

const IS_WIN = process.platform === "win32";

export function autoInstallEnabled(): boolean {
  return !process.env.MINDWEAVE_NO_AUTO_INSTALL;
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function installDir(key: string): string {
  return join(homedir(), ".mindweave", "servers", key);
}

/** The launch command for an already-installed server, or null if not installed. */
export function resolveInstalled(key: string, spec: InstallSpec): string | null {
  const dir = installDir(key);
  if (spec.source === "npm") {
    const bin = join(dir, "node_modules", ".bin", spec.binName + (IS_WIN ? ".cmd" : ""));
    return existsSync(bin) ? bin : null;
  }
  const target = spec.targets[platformKey()];
  if (!target) return null;
  const bin = join(dir, target.bin.replaceAll("{version}", spec.version));
  return existsSync(bin) ? bin : null;
}

const inflight = new Map<string, Promise<string | null>>();

/**
 * Return the install command path, installing the server first if needed.
 * Deduped per key; best-effort (returns null on any failure or when disabled).
 */
export function ensureInstalled(
  key: string,
  spec: InstallSpec,
  log?: (msg: string) => void,
): Promise<string | null> {
  const already = resolveInstalled(key, spec);
  if (already) return Promise.resolve(already);
  if (!autoInstallEnabled()) return Promise.resolve(null);

  let p = inflight.get(key);
  if (!p) {
    p = doInstall(key, spec, log).catch(() => null);
    inflight.set(key, p);
  }
  return p;
}

async function doInstall(key: string, spec: InstallSpec, log?: (m: string) => void): Promise<string | null> {
  log?.(`installing ${key} (${spec.source})…`);
  await fs.mkdir(installDir(key), { recursive: true });
  const ok = spec.source === "npm" ? await installNpm(key, spec) : await installGithub(key, spec);
  if (!ok) {
    log?.(`could not install ${key} — using tree-sitter for now`);
    return null;
  }
  const resolved = resolveInstalled(key, spec);
  log?.(resolved ? `installed ${key}` : `installed ${key} but couldn't find its binary`);
  return resolved;
}

// ── npm source ──────────────────────────────────────────────────────────────
async function installNpm(key: string, spec: NpmInstall): Promise<boolean> {
  const dir = installDir(key);
  // Root npm at this dir with a private package.json — otherwise npm walks up
  // looking for one and can try to write node_modules at the drive root (EPERM).
  await fs.writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `mindweave-server-${key}`, version: "0.0.0", private: true }),
  );
  // Pass the whole command as one string for the shell (npm is a .cmd shim on
  // Windows). Args are from the curated registry, not user input.
  const cmd = `npm install ${spec.package}@${spec.version} --no-save --no-audit --no-fund --loglevel=error`;
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, { cwd: dir, shell: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ── github source ────────────────────────────────────────────────────────────
async function installGithub(key: string, spec: GithubInstall): Promise<boolean> {
  const target = spec.targets[platformKey()];
  if (!target) return false; // this OS/arch isn't published — degrade to tree-sitter
  const dir = installDir(key);
  const asset = target.asset.replaceAll("{version}", spec.version);
  const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${asset}`;
  const archive = join(dir, asset);

  if (!(await download(url, archive))) return false;
  try {
    if (asset.endsWith(".zip")) {
      new AdmZip(archive).extractAllTo(dir, true);
    } else if (asset.endsWith(".tar.gz") || asset.endsWith(".tgz") || asset.endsWith(".tar.xz")) {
      if (!(await runTar(archive, dir))) return false;
    } else if (asset.endsWith(".gz")) {
      // Single-file gzip → the decompressed bytes ARE the binary.
      const out = zlib.gunzipSync(await fs.readFile(archive));
      await fs.mkdir(join(dir, target.bin, ".."), { recursive: true });
      await fs.writeFile(join(dir, target.bin.replaceAll("{version}", spec.version)), out);
    } else {
      return false; // unknown archive format
    }
  } catch {
    return false;
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }

  const bin = join(dir, target.bin.replaceAll("{version}", spec.version));
  if (!IS_WIN && existsSync(bin)) {
    try {
      await fs.chmod(bin, 0o755);
    } catch {
      /* not fatal */
    }
  }
  return existsSync(bin);
}

/** Download `url` to `dest` (follows GitHub's redirect to the CDN). */
async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return false;
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/** Extract a tarball with the system `tar` (handles .tar.gz / .tar.xz on every
 *  platform; Windows 10+ ships bsdtar). */
function runTar(archive: string, dir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("tar", ["-xf", archive, "-C", dir], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
