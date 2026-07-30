/**
 * provision.test.ts — the auto-installer.
 *
 * The deterministic parts run always. The real network install is gated behind
 * MINDWEAVE_TEST_NETWORK so the default suite stays fast and offline-green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the install cache under a throwaway home.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-prov-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const { resolveInstalled, ensureInstalled, autoInstallEnabled, platformKey } = await import("./provision.js");

const NPM_SPEC = { source: "npm" as const, package: "bash-language-server", version: "5.4.3", binName: "bash-language-server" };

test("platformKey looks like <platform>-<arch>", () => {
  assert.match(platformKey(), /^(win32|darwin|linux)-(x64|arm64|arm|ia32)$/);
});

test("resolveInstalled is null before anything is installed", () => {
  assert.equal(resolveInstalled("bash-language-server", NPM_SPEC), null);
});

test("autoInstallEnabled honors MINDWEAVE_NO_AUTO_INSTALL", () => {
  const prev = process.env.MINDWEAVE_NO_AUTO_INSTALL;
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  assert.equal(autoInstallEnabled(), true);
  process.env.MINDWEAVE_NO_AUTO_INSTALL = "1";
  assert.equal(autoInstallEnabled(), false);
  if (prev === undefined) delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  else process.env.MINDWEAVE_NO_AUTO_INSTALL = prev;
});

test("ensureInstalled returns null (no-op) when auto-install is disabled", async () => {
  const prev = process.env.MINDWEAVE_NO_AUTO_INSTALL;
  process.env.MINDWEAVE_NO_AUTO_INSTALL = "1";
  const cmd = await ensureInstalled("never-installed", NPM_SPEC);
  assert.equal(cmd, null);
  if (prev === undefined) delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  else process.env.MINDWEAVE_NO_AUTO_INSTALL = prev;
});

test(
  "npm auto-install fetches a real server (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 180_000 },
  async () => {
    delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
    const cmd = await ensureInstalled("bash-language-server", NPM_SPEC);
    assert.ok(cmd, "should resolve to an installed binary");
    assert.ok(existsSync(cmd!), "the binary should exist on disk");
  },
);

test(
  "github auto-install downloads + extracts a real binary (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 180_000 },
  async () => {
    delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
    const spec = {
      source: "github" as const,
      repo: "rust-lang/rust-analyzer",
      version: "2026-06-22",
      targets: {
        "win32-x64": { asset: "rust-analyzer-x86_64-pc-windows-msvc.zip", bin: "rust-analyzer.exe" },
        "win32-arm64": { asset: "rust-analyzer-aarch64-pc-windows-msvc.zip", bin: "rust-analyzer.exe" },
        "darwin-x64": { asset: "rust-analyzer-x86_64-apple-darwin.gz", bin: "rust-analyzer" },
        "darwin-arm64": { asset: "rust-analyzer-aarch64-apple-darwin.gz", bin: "rust-analyzer" },
        "linux-x64": { asset: "rust-analyzer-x86_64-unknown-linux-gnu.gz", bin: "rust-analyzer" },
        "linux-arm64": { asset: "rust-analyzer-aarch64-unknown-linux-gnu.gz", bin: "rust-analyzer" },
      },
    };
    const cmd = await ensureInstalled("rust-analyzer", spec);
    assert.ok(cmd, "should resolve to the downloaded binary");
    assert.ok(existsSync(cmd!), "the binary should exist on disk");
  },
);
