/**
 * JPEG stream structure parser and embedded-JPEG scanner.
 *
 * RAW files carry one or more ordinary JPEG previews (Sony/Nikon/Canon/Fuji
 * all embed a ~1–2 MP "PreviewImage", plus a 160 px thumbnail). The scanner
 * finds every SOI (FF D8 FF), then walks the marker segments properly —
 * skipping segment payloads by their length and entropy-coded data up to the
 * next real marker (FF xx with xx ∉ {00, D0..D7}) — so false EOIs inside
 * compressed data or nested EXIF thumbnails do not cut a preview short.
 * Candidates are validated (8-bit baseline/extended/progressive Huffman SOF
 * with 1 or 3 components, at least one SOS, reached EOI); lossless JPEG
 * (SOF3, used for the RAW data itself in CR2/DNG) is rejected.
 */
import { u16be } from './binary';
import { openTiff, readIfd, num } from './tiff-ifd';

export interface JpegInfo {
  /** Byte range [offset, end) of the complete stream (SOI..EOI inclusive). */
  offset: number;
  end: number;
  width: number;
  height: number;
  components: number;
  precision: number;
  /** SOF marker (0xC0..0xCF). */
  sof: number;
  /** EXIF orientation from the stream's own APP1, if any. */
  orientation?: number;
}

const DECODABLE_SOF = new Set([0xc0, 0xc1, 0xc2]);

/**
 * Parse one JPEG stream starting at `start` (which must point at FF D8).
 * Returns null when the structure is invalid.
 */
export function parseJpegAt(b: Uint8Array, start: number, opts: { readOrientation?: boolean } = {}): JpegInfo | null {
  const n = b.length;
  if (start + 4 > n || b[start] !== 0xff || b[start + 1] !== 0xd8) return null;
  let p = start + 2;
  let width = 0;
  let height = 0;
  let components = 0;
  let precision = 0;
  let sof = 0;
  let sawScan = false;
  let orientation: number | undefined;
  while (p < n) {
    if (b[p] !== 0xff) return null;
    // Fill bytes: any number of FF before the marker code.
    while (p < n && b[p] === 0xff) p++;
    if (p >= n) return null;
    const m = b[p++];
    if (m === 0xd9) {
      if (!sof || !sawScan) return null;
      return { offset: start, end: p, width, height, components, precision, sof, orientation };
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers
    if (m === 0xd8 || m === 0x00) return null;
    if (p + 2 > n) return null;
    const len = u16be(b, p);
    if (len < 2 || p + len > n) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (sof) return null; // two frames: not a single image stream
      if (len < 8) return null;
      sof = m;
      precision = b[p + 2];
      height = u16be(b, p + 3);
      width = u16be(b, p + 5);
      components = b[p + 7];
    } else if (m === 0xe1 && opts.readOrientation && orientation === undefined && len > 16) {
      // "Exif\0\0" + TIFF
      if (b[p + 2] === 0x45 && b[p + 3] === 0x78 && b[p + 4] === 0x69 && b[p + 5] === 0x66) {
        const tiff = b.subarray(p + 8, p + len);
        const t = openTiff(tiff);
        if (t) {
          const o = num(readIfd(t, t.ifd0, 64).tags, 274);
          if (o && o >= 1 && o <= 8) orientation = o;
        }
      }
    }
    p += len;
    if (m === 0xda) {
      sawScan = true;
      // Entropy-coded segment: advance to the next marker that is not a
      // stuffed zero or a restart marker.
      for (;;) {
        const q = b.indexOf(0xff, p);
        if (q < 0 || q + 1 >= n) return null;
        const nx = b[q + 1];
        if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7) || nx === 0xff) {
          p = nx === 0xff ? q + 1 : q + 2;
          continue;
        }
        p = q;
        break;
      }
    }
  }
  return null;
}

export function isDecodableJpeg(j: JpegInfo): boolean {
  return DECODABLE_SOF.has(j.sof) && j.precision === 8 && (j.components === 1 || j.components === 3) && j.width > 0 && j.height > 0;
}

/**
 * Every valid, browser-decodable JPEG stream embedded in `b`, in file order.
 * After a match the scan resumes at its end, so thumbnails nested inside a
 * preview's EXIF are not reported twice.
 */
export function findEmbeddedJpegs(b: Uint8Array, opts: { minSide?: number; readOrientation?: boolean } = {}): JpegInfo[] {
  const out: JpegInfo[] = [];
  const minSide = opts.minSide ?? 1;
  let i = 0;
  const n = b.length;
  while (i < n - 3) {
    i = b.indexOf(0xff, i);
    if (i < 0 || i >= n - 3) break;
    if (b[i + 1] === 0xd8 && b[i + 2] === 0xff) {
      const j = parseJpegAt(b, i, { readOrientation: opts.readOrientation });
      if (j) {
        if (isDecodableJpeg(j) && Math.min(j.width, j.height) >= minSide) out.push(j);
        i = j.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The embedded JPEG with the most pixels, or null. */
export function largestEmbeddedJpeg(b: Uint8Array, opts: { readOrientation?: boolean } = {}): JpegInfo | null {
  let best: JpegInfo | null = null;
  for (const j of findEmbeddedJpegs(b, opts)) {
    if (!best || j.width * j.height > best.width * best.height) best = j;
  }
  return best;
}

/**
 * Smallest embedded JPEG whose long edge is ≥ `minLong` (falls back to the
 * largest one). Used for thumbnails: decoding a 1.6 MP preview is far
 * cheaper than a 6 MP "JpgFromRaw".
 */
export function bestPreviewFor(b: Uint8Array, minLong: number): JpegInfo | null {
  const all = findEmbeddedJpegs(b, { readOrientation: true });
  let fit: JpegInfo | null = null;
  let largest: JpegInfo | null = null;
  for (const j of all) {
    const long = Math.max(j.width, j.height);
    if (!largest || j.width * j.height > largest.width * largest.height) largest = j;
    if (long >= minLong && (!fit || j.width * j.height < fit.width * fit.height)) fit = j;
  }
  return fit ?? largest;
}

/** Header info (size, orientation) of a standalone JPEG file, without scanning the entropy data. */
export function jpegHeaderInfo(b: Uint8Array): { width: number; height: number; orientation?: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  let orientation: number | undefined;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    while (p < b.length && b[p] === 0xff) p++;
    const m = b[p++];
    if (m === 0xd9 || m === 0xda) return null;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    const len = u16be(b, p);
    if (len < 2) return null;
    if (m === 0xe1 && orientation === undefined && p + len <= b.length && b[p + 2] === 0x45 && b[p + 3] === 0x78) {
      const t = openTiff(b.subarray(p + 8, p + len));
      if (t) {
        const o = num(readIfd(t, t.ifd0, 64).tags, 274);
        if (o && o >= 1 && o <= 8) orientation = o;
      }
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (p + 7 > b.length) return null;
      return { height: u16be(b, p + 3), width: u16be(b, p + 5), orientation };
    }
    p += len;
  }
  return null;
}

/** Concatenated ICC profile from APP2 "ICC_PROFILE" chunks (in chunk order), or null. */
export function jpegIccProfile(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const chunks: { seq: number; data: Uint8Array }[] = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) break;
    while (p < b.length && b[p] === 0xff) p++;
    const m = b[p++];
    if (m === 0xd9 || m === 0xda) break;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    const len = u16be(b, p);
    if (len < 2 || p + len > b.length) break;
    // "ICC_PROFILE\0" seq count
    if (m === 0xe2 && len > 16 && b[p + 2] === 0x49 && b[p + 3] === 0x43 && b[p + 4] === 0x43 && b[p + 13] === 0) {
      chunks.push({ seq: b[p + 14], data: b.subarray(p + 16, p + len) });
    }
    p += len;
  }
  if (!chunks.length) return null;
  chunks.sort((a, c) => a.seq - c.seq);
  const total = chunks.reduce((s, c) => s + c.data.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c.data, o);
    o += c.data.length;
  }
  return out;
}
