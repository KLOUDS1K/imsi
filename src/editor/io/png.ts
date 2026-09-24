/**
 * Pure-TS PNG decoder (all colour types, bit depths 1–16, Adam7). The browser
 * decodes PNGs to 8 bits, so 16-bit files go through here to keep their full
 * precision (Uint16 RGBA). Works in workers and in Node (tests).
 *
 * Inflate is fflate; unfiltering follows the PNG spec (filters 0–4, "bpp" =
 * bytes per complete pixel, at least 1). Also returns the decompressed iCCP
 * profile and the eXIf orientation, when present.
 */
import { unzlibSync } from 'fflate';
import { ascii, u16be, u32be } from './binary';
import { openTiff, readIfd, num } from './tiff-ifd';

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export interface PngImage extends PngHeader {
  /** RGBA; Uint16Array when bitDepth === 16, else Uint8Array. */
  data: Uint8Array | Uint16Array;
  icc?: Uint8Array;
  orientation?: number;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return false;
  return true;
}

export function readPngHeader(b: Uint8Array): PngHeader | null {
  if (!isPng(b) || b.length < 33 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20), bitDepth: b[24], colorType: b[25], interlace: b[28] };
}

export function decodePng(b: Uint8Array): PngImage {
  const hdr = readPngHeader(b);
  if (!hdr) throw new Error('Not a PNG file');
  const { width: W, height: H, bitDepth: bd, colorType: ct } = hdr;
  const ch = CHANNELS[ct];
  if (!ch || ![1, 2, 4, 8, 16].includes(bd) || W === 0 || H === 0) throw new Error(`Unsupported PNG (colour type ${ct}, ${bd} bit)`);
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  let icc: Uint8Array | undefined;
  let orientation: number | undefined;
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const d = p + 8;
    if (d + len > b.length) throw new Error('Truncated PNG');
    const data = b.subarray(d, d + len);
    if (type === 'IDAT') {
      idat.push(data);
      idatLen += len;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'iCCP') icc = readIccp(data);
    else if (type === 'eXIf') orientation = exifOrientation(data);
    else if (type === 'IEND') break;
    p = d + len + 4;
  }
  if (!idat.length) throw new Error('PNG has no image data');
  let z: Uint8Array;
  if (idat.length === 1) z = idat[0];
  else {
    z = new Uint8Array(idatLen);
    let o = 0;
    for (const c of idat) {
      z.set(c, o);
      o += c.length;
    }
  }
  const raw = unzlibSync(z);
  const bitsPP = ch * bd;
  const bpp = Math.max(1, bitsPP >> 3);
  const out = bd === 16 ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
  const ctx: EmitCtx = { ct, bd, palette, trns, out, W };
  let off = 0;
  if (hdr.interlace === 1) {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((W - x0) / dx);
      const ph = Math.ceil((H - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const stride = Math.ceil((pw * bitsPP) / 8);
      off = unfilter(raw, off, stride, ph, bpp, (row, y) => emitRow(ctx, row, pw, (y0 + y * dy) * W + x0, dx));
    }
  } else {
    const stride = Math.ceil((W * bitsPP) / 8);
    unfilter(raw, 0, stride, H, bpp, (row, y) => emitRow(ctx, row, W, y * W, 1));
  }
  return { ...hdr, data: out, icc, orientation };
}

/** Unfilter `rows` scanlines of `stride` bytes (+1 filter byte each) starting at `off`. Returns the next offset. */
function unfilter(
  raw: Uint8Array,
  off: number,
  stride: number,
  rows: number,
  bpp: number,
  emit: (row: Uint8Array, y: number) => void,
): number {
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < rows; y++) {
    if (off + 1 + stride > raw.length) throw new Error('Truncated PNG data');
    const f = raw[off];
    const src = off + 1;
    switch (f) {
      case 0:
        cur.set(raw.subarray(src, src + stride));
        break;
      case 1:
        for (let i = 0; i < stride; i++) cur[i] = (raw[src + i] + (i >= bpp ? cur[i - bpp] : 0)) & 255;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (raw[src + i] + prev[i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i++) cur[i] = (raw[src + i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const bb = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const pp = a + bb - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - bb);
          const pc = Math.abs(pp - c);
          cur[i] = (raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
        }
        break;
      default:
        throw new Error(`Bad PNG filter ${f}`);
    }
    emit(cur, y);
    const t = prev;
    prev = cur;
    cur = t;
    off = src + stride;
  }
  return off;
}

interface EmitCtx {
  ct: number;
  bd: number;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  out: Uint8Array | Uint16Array;
  W: number;
}

/** Expand one unfiltered scanline of `n` pixels into RGBA at pixel index `start`, stepping `step` pixels. */
function emitRow(c: EmitCtx, row: Uint8Array, n: number, start: number, step: number): void {
  const { ct, bd, out, trns } = c;
  let o = start * 4;
  const os = step * 4;
  if (bd === 16) {
    const key = trns && ct !== 3 ? trns : null;
    for (let i = 0; i < n; i++, o += os) {
      let r: number, g: number, bl: number, a = 65535;
      if (ct === 0 || ct === 4) {
        const q = i * (ct === 0 ? 2 : 4);
        r = g = bl = (row[q] << 8) | row[q + 1];
        if (ct === 4) a = (row[q + 2] << 8) | row[q + 3];
        else if (key && key.length >= 2 && r === u16be(key, 0)) a = 0;
      } else {
        const q = i * (ct === 2 ? 6 : 8);
        r = (row[q] << 8) | row[q + 1];
        g = (row[q + 2] << 8) | row[q + 3];
        bl = (row[q + 4] << 8) | row[q + 5];
        if (ct === 6) a = (row[q + 6] << 8) | row[q + 7];
        else if (key && key.length >= 6 && r === u16be(key, 0) && g === u16be(key, 2) && bl === u16be(key, 4)) a = 0;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
      out[o + 3] = a;
    }
    return;
  }
  if (bd === 8) {
    for (let i = 0; i < n; i++, o += os) {
      switch (ct) {
        case 0: {
          const v = row[i];
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = trns && trns.length >= 2 && v === u16be(trns, 0) ? 0 : 255;
          break;
        }
        case 2: {
          const q = i * 3;
          out[o] = row[q];
          out[o + 1] = row[q + 1];
          out[o + 2] = row[q + 2];
          out[o + 3] =
            trns && trns.length >= 6 && row[q] === u16be(trns, 0) && row[q + 1] === u16be(trns, 2) && row[q + 2] === u16be(trns, 4) ? 0 : 255;
          break;
        }
        case 3:
          writePalette(c, row[i], o);
          break;
        case 4: {
          const q = i * 2;
          out[o] = out[o + 1] = out[o + 2] = row[q];
          out[o + 3] = row[q + 1];
          break;
        }
        default: {
          const q = i * 4;
          out[o] = row[q];
          out[o + 1] = row[q + 1];
          out[o + 2] = row[q + 2];
          out[o + 3] = row[q + 3];
        }
      }
    }
    return;
  }
  // 1, 2, 4 bit: gray (ct 0) or palette (ct 3), packed MSB-first.
  const mask = (1 << bd) - 1;
  const scale = 255 / mask;
  const key = ct === 0 && trns && trns.length >= 2 ? u16be(trns, 0) : -1;
  for (let i = 0; i < n; i++, o += os) {
    const bit = i * bd;
    const v = (row[bit >> 3] >> (8 - bd - (bit & 7))) & mask;
    if (ct === 3) writePalette(c, v, o);
    else {
      const g = Math.round(v * scale);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = v === key ? 0 : 255;
    }
  }
}

function writePalette(c: EmitCtx, idx: number, o: number): void {
  const pal = c.palette;
  const out = c.out;
  if (!pal || idx * 3 + 2 >= pal.length) {
    out[o] = out[o + 1] = out[o + 2] = 0;
    out[o + 3] = 255;
    return;
  }
  out[o] = pal[idx * 3];
  out[o + 1] = pal[idx * 3 + 1];
  out[o + 2] = pal[idx * 3 + 2];
  out[o + 3] = c.trns && idx < c.trns.length ? c.trns[idx] : 255;
}

function readIccp(d: Uint8Array): Uint8Array | undefined {
  const nul = d.indexOf(0);
  if (nul < 0 || nul + 2 > d.length || d[nul + 1] !== 0) return undefined;
  try {
    return unzlibSync(d.subarray(nul + 2));
  } catch {
    return undefined;
  }
}

function exifOrientation(d: Uint8Array): number | undefined {
  const t = openTiff(d);
  if (!t) return undefined;
  const o = num(readIfd(t, t.ifd0, 64).tags, 274);
  return o && o >= 1 && o <= 8 ? o : undefined;
}
