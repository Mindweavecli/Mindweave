/**
 * images.test.ts — the provider-neutral image facts: header parsing (which is what
 * makes the token estimate real rather than a guess), the caps, and the cost model
 * the compaction bars depend on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGE_BYTES,
  describeImage,
  estimateImageTokens,
  estimateImagesTokens,
  isImage,
  isRejection,
  mediaTypeFor,
  readDimensions,
} from "./images.js";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A JPEG whose SOF0 frame reports the given size, behind one skippable segment —
 *  so this exercises the marker WALK, not just the first two bytes. */
function jpeg(width: number, height: number): Buffer {
  const parts = [
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0, length 4 — must be skipped
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), // SOF0
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(height, 0);
      b.writeUInt16BE(width, 2);
      return b;
    })(),
    Buffer.alloc(8),
  ];
  return Buffer.concat(parts);
}

// ── header parsing ────────────────────────────────────────────────────────────

test("PNG dimensions come out of the IHDR chunk", () => {
  assert.deepEqual(readDimensions(png(1920, 1080)), { width: 1920, height: 1080 });
});

test("JPEG dimensions are found by walking past earlier segments", () => {
  // The APP0 segment sits between SOI and SOF0. A parser that reads a fixed offset
  // instead of walking the chain gets garbage here, silently.
  assert.deepEqual(readDimensions(jpeg(800, 600)), { width: 800, height: 600 });
});

test("GIF dimensions are little-endian, unlike every other format here", () => {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(640, 6);
  buf.writeUInt16LE(480, 8);
  assert.deepEqual(readDimensions(buf), { width: 640, height: 480 });
});

test("an unparseable header returns null rather than throwing or guessing", () => {
  assert.equal(readDimensions(Buffer.from("not an image at all")), null);
  assert.equal(readDimensions(Buffer.alloc(0)), null);
  // A JPEG that claims a zero-length segment would loop forever if unguarded.
  assert.equal(readDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0])), null);
});

// ── the cost model the compaction bars read ───────────────────────────────────

test("cost scales with AREA, not with path length", () => {
  const small = estimateImageTokens({ path: "a.png", mediaType: "image/png", width: 200, height: 200 });
  const big = estimateImageTokens({ path: "b.png", mediaType: "image/png", width: 1000, height: 1000 });
  assert.equal(small, 64); // ⌈200/28⌉² = 8² = 64
  assert.equal(big, 1296); // ⌈1000/28⌉² = 36² = 1296
  assert.ok(big > small * 10, "a 25x bigger area must cost far more, not marginally more");
});

test("a 1080p screenshot costs thousands of tokens — the number that motivated eviction", () => {
  const shot = estimateImageTokens({ path: "s.png", mediaType: "image/png", width: 1920, height: 1080 });
  assert.ok(shot > 2000, `a screenshot must not look cheap (got ${shot})`);
});

test("cost is capped, and unknown dimensions assume the cap rather than zero", () => {
  const huge = estimateImageTokens({ path: "h.png", mediaType: "image/png", width: 8000, height: 8000 });
  const unknown = estimateImageTokens({ path: "u.webp", mediaType: "image/webp" });
  assert.equal(huge, 4784, "providers downscale, so cost must stop climbing");
  assert.equal(unknown, 4784, "erring high is safe; erring low makes the bars fire late");
});

test("estimateImagesTokens sums, and is zero for no images", () => {
  assert.equal(estimateImagesTokens(undefined), 0);
  assert.equal(estimateImagesTokens([]), 0);
  const two = estimateImagesTokens([
    { path: "a.png", mediaType: "image/png", width: 200, height: 200 },
    { path: "b.png", mediaType: "image/png", width: 200, height: 200 },
  ]);
  assert.equal(two, 128);
});

// ── format and cap gates ──────────────────────────────────────────────────────

test("recognized-as-an-image is wider than can-be-sent, on purpose", () => {
  assert.ok(isImage("x.svg"), "so the user is told the format is wrong, not 'binary, skipped'");
  assert.equal(mediaTypeFor("x.svg"), null, "but it is still not sendable");
  assert.equal(mediaTypeFor("x.PNG"), "image/png", "extension check is case-insensitive");
  assert.equal(mediaTypeFor("x.jpeg"), "image/jpeg");
  assert.equal(mediaTypeFor("notes.txt"), null);
});

test("describeImage rejects an oversized file without reading it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-img-"));
  try {
    const p = join(dir, "big.png");
    await fs.writeFile(p, png(100, 100)); // tiny on disk; we lie about the size below
    const verdict = await describeImage(p, MAX_IMAGE_BYTES + 1);
    assert.ok(isRejection(verdict));
    assert.match(verdict.reason, /too large to send/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("describeImage rejects an image past the per-side pixel limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-img-"));
  try {
    const p = join(dir, "wide.png");
    await fs.writeFile(p, png(9000, 100));
    const verdict = await describeImage(p, 1024);
    assert.ok(isRejection(verdict));
    assert.match(verdict.reason, /9000x100/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("describeImage returns a ref with dimensions for a good image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-img-"));
  try {
    const p = join(dir, "ok.png");
    await fs.writeFile(p, png(1024, 768));
    const verdict = await describeImage(p, 2048);
    assert.ok(!isRejection(verdict));
    assert.equal(verdict.mediaType, "image/png");
    assert.equal(verdict.width, 1024);
    assert.equal(verdict.height, 768);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable header is not fatal — the ref survives without dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-img-"));
  try {
    const p = join(dir, "truncated.png");
    await fs.writeFile(p, Buffer.from([0x89, 0x50])); // not enough for an IHDR
    const verdict = await describeImage(p, 2);
    assert.ok(!isRejection(verdict), "a header we can't parse must not block the attachment");
    assert.equal(verdict.width, undefined);
    assert.equal(estimateImageTokens(verdict), 4784, "and it costs the cap, not nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
