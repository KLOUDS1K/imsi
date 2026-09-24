/**
 * PNG encoder (8- and 16-bit, RGB or RGBA) with per-row adaptive filtering and
 * fflate zlib, plus iCCP / pHYs / eXIf / iTXt(XMP) chunks. Synchronous and
 * DOM-free: it runs inside the encode worker (and in Node unit tests).
 *
 * Filter choice uses libpng's "minimum sum of absolute differences" heuristic:
 * each row is filtered with all five filters and the one whose output bytes
 * (read as signed) have the smallest absolute sum wins — a cheap proxy for
 * what deflate compresses best.
 */
import { zlibSync } from 'fflate';
import { concatBytes, crc32, latin1, putU32be, utf8 } from './bytes';

export interface PngMetadata {
  icc?: { name: string; data: Uint8Array } | null;
  dpi?: number;
  /** TIFF structure for the eXIf chunk. */
  exif?: Uint8Array | null;
  xmp?: string | null;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + data.length);
  putU32be(c, 0, data.length);
  c.set(latin1(type), 4);
  c.set(data, 8);
  putU32be(c, 8 + data.length, crc32(c, 4, 8 + data.length));
  return c;
}

/** Whether every alpha sample is fully opaque (then RGB is written instead of RGBA). */
export function isOpaque(data: ArrayLike<number>, max: number): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== max) return false;
  return true;
}

/** Pack one row of RGBA samples into PNG byte order (16-bit big-endian). */
function packRow(
  src: Uint8ClampedArray | Uint16Array | Uint8Array,
  y: number,
  width: number,
  channels: 3 | 4,
  sixteen: boolean,
  out: Uint8Array,
): void {
  let s = y * width * 4;
  let o = 0;
  if (sixteen) {
    for (let x = 0; x < width; x++, s += 4) {
      for (let c = 0; c < channels; c++) {
        const v = src[s + c];
        out[o++] = v >>> 8;
        out[o++] = v & 0xff;
      }
    }
  } else if (channels === 4) {
    out.set(src.subarray(s, s + width * 4));
  } else {
    for (let x = 0; x < width; x++, s += 4) {
      out[o++] = src[s];
      out[o++] = src[s + 1];
      out[o++] = src[s + 2];
    }
  }
}

const absSigned = (v: number) => (v < 128 ? v : 256 - v);

/**
 * Filter one row with all five filters into `scratch` (5 × n bytes) and return
 * the index of the best one.
 */
function chooseFilter(cur: Uint8Array, prev: Uint8Array, bpp: number, scratch: Uint8Array): number {
  const n = cur.length;
  let best = 0;
  let bestSum = Infinity;
  // 0: None
  let sum = 0;
  for (let i = 0; i < n; i++) sum += absSigned(cur[i]);
  bestSum = sum;
  // 1: Sub
  let o = n;
  sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
    scratch[o + i] = v;
    sum += absSigned(v);
  }
  if (sum < bestSum) (bestSum = sum), (best = 1);
  // 2: Up
  o = 2 * n;
  sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (cur[i] - prev[i]) & 0xff;
    scratch[o + i] = v;
    sum += absSigned(v);
  }
  if (sum < bestSum) (bestSum = sum), (best = 2);
  // 3: Average
  o = 3 * n;
  sum = 0;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const v = (cur[i] - ((a + prev[i]) >>> 1)) & 0xff;
    scratch[o + i] = v;
    sum += absSigned(v);
  }
  if (sum < bestSum) (bestSum = sum), (best = 3);
  // 4: Paeth
  o = 4 * n;
  sum = 0;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const p = a + b - c;
    const pa = p > a ? p - a : a - p;
    const pb = p > b ? p - b : b - p;
    const pc = p > c ? p - c : c - p;
    const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    const v = (cur[i] - pred) & 0xff;
    scratch[o + i] = v;
    sum += absSigned(v);
  }
  if (sum < bestSum) best = 4;
  return best;
}

/** Filtered scanlines (filter byte + row) ready for zlib. */
export function filterScanlines(
  data: Uint8ClampedArray | Uint16Array | Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  channels: 3 | 4,
): Uint8Array {
  const bpp = channels * (bitDepth / 8);
  const rowBytes = width * bpp;
  const out = new Uint8Array(height * (rowBytes + 1));
  let cur = new Uint8Array(rowBytes);
  let prev = new Uint8Array(rowBytes); // zero row above the first scanline
  const scratch = new Uint8Array(rowBytes * 5);
  for (let y = 0; y < height; y++) {
    packRow(data, y, width, channels, bitDepth === 16, cur);
    const f = chooseFilter(cur, prev, bpp, scratch);
    const o = y * (rowBytes + 1);
    out[o] = f;
    if (f === 0) out.set(cur, o + 1);
    else out.set(scratch.subarray(f * rowBytes, (f + 1) * rowBytes), o + 1);
    const t = prev;
    prev = cur;
    cur = t;
  }
  return out;
}

export function encodePng(
  data: Uint8ClampedArray | Uint16Array | Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  meta: PngMetadata = {},
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array {
  if (data.length !== width * height * 4) throw new Error('PNG: data length does not match RGBA size');
  const channels: 3 | 4 = isOpaque(data, bitDepth === 16 ? 65535 : 255) ? 3 : 4;

  const ihdr = new Uint8Array(13);
  putU32be(ihdr, 0, width);
  putU32be(ihdr, 4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA / RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (meta.icc) {
    const name = latin1(meta.icc.name.replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'ICC');
    const z = zlibSync(meta.icc.data, { level: 9 });
    parts.push(pngChunk('iCCP', concatBytes([name, new Uint8Array([0, 0]), z])));
  }
  if (meta.dpi && meta.dpi > 0) {
    const ppm = Math.round(meta.dpi / 0.0254);
    const p = new Uint8Array(9);
    putU32be(p, 0, ppm);
    putU32be(p, 4, ppm);
    p[8] = 1; // unit: metre
    parts.push(pngChunk('pHYs', p));
  }
  if (meta.exif) parts.push(pngChunk('eXIf', meta.exif));
  if (meta.xmp) {
    // iTXt: keyword\0 compression-flag compression-method language\0 translated\0 text
    const head = latin1('XML:com.adobe.xmp');
    parts.push(pngChunk('iTXt', concatBytes([head, new Uint8Array([0, 0, 0, 0, 0]), utf8(meta.xmp)])));
  }

  const idat = zlibSync(filterScanlines(data, width, height, bitDepth, channels), { level });
  const CH = 1 << 20;
  for (let o = 0; o < idat.length; o += CH) parts.push(pngChunk('IDAT', idat.subarray(o, Math.min(idat.length, o + CH))));
  if (idat.length === 0) parts.push(pngChunk('IDAT', idat));
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return concatBytes(parts);
}
