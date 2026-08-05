/**
 * images.ts — the provider-neutral facts about an image attachment.
 *
 * One module owns everything core needs to know about an image without knowing
 * which model will receive it: what kinds exist, what the caps are, how big it is
 * on screen, and roughly what it will cost in context. Drivers own the wire shape;
 * this owns the facts they all share.
 *
 * WHY A REFERENCE, NOT BYTES. An `ImageRef` is a path plus a media type — never the
 * payload. The transcript stores refs, and the bytes are loaded only when a request
 * is assembled. That keeps a session's JSONL small and readable, keeps resume cheap,
 * and follows compaction's eviction rule directly: an image on disk is maximally
 * reconstructible, and the path is the restoration key. The cost is that a file can
 * change or vanish between the turn it was attached and a later turn; a missing file
 * degrades to a note rather than an error, because a broken attachment must never
 * take the conversation down with it.
 */
import { promises as fs } from "node:fs";
import { extname } from "node:path";

/**
 * Media types every vision-capable provider accepts today. The intersection, not the
 * union: a format only one provider takes would attach fine and then fail at the wire
 * on the others, which is a worse experience than declining it up front.
 */
const MEDIA_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * Image extensions Mindweave RECOGNIZES, which is deliberately wider than the set it
 * can send. A `.bmp` or `.svg` is still identified as an image so the user gets
 * "that format can't be sent" instead of a generic "binary file, skipped".
 */
export const IMAGE_EXTS = new Set([
  ...MEDIA_TYPES.keys(),
  ".bmp",
  ".svg",
  ".ico",
  ".tiff",
  ".avif",
  ".heic",
]);

/**
 * Per-image ceiling. Providers state their limit on the BASE64 payload (10 MB is the
 * common figure), and base64 inflates by 4/3, so the raw-file cap that keeps us under
 * it is 7.5 MB. Enforced on the file, before encoding, so an oversized image is
 * refused without ever being read into memory twice.
 */
export const MAX_IMAGE_BYTES = Math.floor(7.5 * 1024 * 1024);

/** Longest edge any provider accepts. Beyond this the request is rejected outright. */
export const MAX_IMAGE_EDGE = 8000;

/**
 * A stored image attachment: what it is and where it lives. This is what goes in the
 * transcript. Deliberately tiny and JSON-plain.
 */
export interface ImageRef {
  /** Absolute path on disk. Doubles as the restoration key once the payload is evicted. */
  path: string;
  /** IANA media type, e.g. `image/png`. */
  mediaType: string;
  /** Pixel size when it could be read from the file header; absent when it couldn't. */
  width?: number;
  height?: number;
}

/** The media type for a path, or null when it is not a format we can send. */
export function mediaTypeFor(path: string): string | null {
  return MEDIA_TYPES.get(extname(path).toLowerCase()) ?? null;
}

/** Whether a path looks like an image at all (sendable or not). */
export function isImage(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

/**
 * Approximate context cost of an image, in tokens.
 *
 * Vision models bill by fixed-size patches rather than pixels, so cost scales with
 * AREA: the published figures work out to roughly a 28x28-pixel patch per visual
 * token, and providers downscale anything larger before charging, which caps the
 * worst case. This reproduces that shape — area over patch area, clamped to the cap.
 *
 * It is an approximation, in the same spirit as `CHARS_PER_TOKEN` for text, and it
 * exists for one reason: the compaction bars ask "how full is the context", and an
 * image counted as zero would make every bar fire late. Counting it approximately is
 * strictly better than counting it as nothing. When dimensions are unknown we assume
 * the cap rather than a small number, so the error is on the safe side.
 */
const PATCH_PX = 28;
const MAX_IMAGE_TOKENS = 4784;

export function estimateImageTokens(ref: ImageRef): number {
  if (!ref.width || !ref.height) return MAX_IMAGE_TOKENS;
  const patches = Math.ceil(ref.width / PATCH_PX) * Math.ceil(ref.height / PATCH_PX);
  return Math.min(patches, MAX_IMAGE_TOKENS);
}

/** Total approximate cost of a set of attachments. */
export function estimateImagesTokens(refs: readonly ImageRef[] | undefined): number {
  if (!refs || refs.length === 0) return 0;
  let total = 0;
  for (const r of refs) total += estimateImageTokens(r);
  return total;
}

/**
 * Read the pixel dimensions out of an image's header.
 *
 * Only the container formats whose headers are unambiguous and cheap to parse are
 * handled — PNG, JPEG and GIF, which covers every screenshot path that matters. WebP
 * has three different chunk layouts and is not worth the surface here: it returns
 * null, and the estimator then assumes the cap. Returning null is always safe.
 *
 * Reads a small prefix, never the whole file.
 */
export function readDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: signature, then an IHDR chunk with width/height at fixed offsets.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then the logical screen size, little-endian.
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG: walk the marker chain to the start-of-frame, which carries the size.
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let pos = 2;
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xff) return null; // not on a marker boundary; give up safely
      const marker = buf[pos + 1]!;
      // SOF0..SOF15 carry the frame size. C4/C8/CC share the range but are tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
      }
      const segment = buf.readUInt16BE(pos + 2);
      if (segment < 2) return null; // malformed length would loop forever
      pos += 2 + segment;
    }
  }

  return null;
}

/** Why an image could not be attached, in words a user can act on. */
export type ImageRejection = { reason: string };

/**
 * Turn a path into an `ImageRef`, or explain why not. Does the format check, the size
 * check and the dimension read in one pass so callers get a single verdict.
 */
export async function describeImage(path: string, sizeBytes: number): Promise<ImageRef | ImageRejection> {
  const mediaType = mediaTypeFor(path);
  if (!mediaType) {
    return { reason: `${extname(path).toLowerCase() || "that format"} images can't be sent to a model` };
  }
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return { reason: `too large to send (${formatMb(sizeBytes)}, limit ${formatMb(MAX_IMAGE_BYTES)})` };
  }

  const dims = await readHeader(path);
  if (dims && (dims.width > MAX_IMAGE_EDGE || dims.height > MAX_IMAGE_EDGE)) {
    return { reason: `too big to send (${dims.width}x${dims.height}, limit ${MAX_IMAGE_EDGE}px per side)` };
  }
  return { path, mediaType, ...(dims ?? {}) };
}

/** True when a verdict from `describeImage` is a refusal rather than a ref. */
export function isRejection(v: ImageRef | ImageRejection): v is ImageRejection {
  return "reason" in v;
}

/** Read just enough of the file to find its dimensions. */
async function readHeader(path: string): Promise<{ width: number; height: number } | null> {
  let handle;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return readDimensions(buf.subarray(0, bytesRead));
  } catch {
    return null; // unreadable header is not fatal — the estimator assumes the cap
  } finally {
    await handle?.close();
  }
}

function formatMb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
