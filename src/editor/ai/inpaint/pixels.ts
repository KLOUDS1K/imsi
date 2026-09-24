/**
 * Pixel helpers for the inpainting module: read any PixelBuffer (8/16-bit,
 * float, sRGB or linear) as 8-bit sRGB RGBA, crop regions and resample.
 *
 * Everything here works on flat typed arrays with no per-pixel allocation.
 */
import { linearToSrgb, srgbToLinear } from '@/editor/color/math';
import type { PixelBuffer, Rect } from '@/editor/types';

/** Integer pixel rectangle (x0,y0 inclusive; w,h in pixels). */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Linear 0..1 → sRGB 8-bit, 16384-entry table (fine enough for deep shadows). */
const LIN_LUT_SIZE = 16384;
let linToSrgb8: Uint8Array | null = null;
function linearLut(): Uint8Array {
  if (!linToSrgb8) {
    linToSrgb8 = new Uint8Array(LIN_LUT_SIZE + 1);
    for (let i = 0; i <= LIN_LUT_SIZE; i++) linToSrgb8[i] = Math.round(linearToSrgb(i / LIN_LUT_SIZE) * 255);
  }
  return linToSrgb8;
}

/** 16-bit sRGB-encoded → 8-bit uses a shift; 16-bit linear goes through the LUT. */
function channelReader(px: PixelBuffer): (v: number) => number {
  const d = px.data;
  const linear = px.transfer === 'linear';
  if (d instanceof Float32Array) {
    if (!linear) return (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
    const lut = linearLut();
    return (v) => (v <= 0 ? 0 : v >= 1 ? 255 : lut[Math.round(v * LIN_LUT_SIZE)]);
  }
  if (d instanceof Uint16Array) {
    if (!linear) return (v) => (v + 128) >> 8 > 255 ? 255 : (v + 128) >> 8;
    const lut = linearLut();
    return (v) => lut[Math.round((v / 65535) * LIN_LUT_SIZE)];
  }
  if (!linear) return (v) => v;
  // 8-bit linear data (rare): decode through the float path.
  const lut = linearLut();
  return (v) => lut[Math.round((v / 255) * LIN_LUT_SIZE)];
}

/**
 * Copy a region of any PixelBuffer into a new 8-bit sRGB RGBA array.
 * The rect must lie inside the buffer.
 */
export function readRgba8Region(px: PixelBuffer, r: PixelRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const src = px.data;
  const W = px.width;
  const direct = (src instanceof Uint8Array || src instanceof Uint8ClampedArray) && px.transfer !== 'linear';
  if (direct) {
    for (let y = 0; y < r.h; y++) {
      const s = ((r.y + y) * W + r.x) * 4;
      out.set(src.subarray(s, s + r.w * 4), y * r.w * 4);
    }
    return out;
  }
  const read = channelReader(px);
  const alphaScale = src instanceof Float32Array ? 255 : src instanceof Uint16Array ? 255 / 65535 : 1;
  for (let y = 0; y < r.h; y++) {
    let s = ((r.y + y) * W + r.x) * 4;
    let o = y * r.w * 4;
    for (let x = 0; x < r.w; x++, s += 4, o += 4) {
      out[o] = read(src[s]);
      out[o + 1] = read(src[s + 1]);
      out[o + 2] = read(src[s + 2]);
      out[o + 3] = src[s + 3] * alphaScale;
    }
  }
  return out;
}

/** Whole buffer as 8-bit sRGB RGBA (always a fresh copy). */
export function readRgba8(px: PixelBuffer): Uint8ClampedArray {
  return readRgba8Region(px, { x: 0, y: 0, w: px.width, h: px.height });
}

/** Read one pixel as sRGB-encoded floats 0..1 (used by the heal source search sampler). */
export function createFloatReader(px: PixelBuffer): (i: number, out: Float32Array) => void {
  const d = px.data;
  const linear = px.transfer === 'linear';
  const scale = d instanceof Float32Array ? 1 : d instanceof Uint16Array ? 1 / 65535 : 1 / 255;
  if (!linear) {
    return (i, out) => {
      out[0] = d[i] * scale;
      out[1] = d[i + 1] * scale;
      out[2] = d[i + 2] * scale;
    };
  }
  return (i, out) => {
    out[0] = linearToSrgb(Math.min(d[i] * scale, 1));
    out[1] = linearToSrgb(Math.min(d[i + 1] * scale, 1));
    out[2] = linearToSrgb(Math.min(d[i + 2] * scale, 1));
  };
}

/** Area-average downscale of RGBA8 (each destination pixel = mean of its source footprint). */
export function downscaleRgba8(src: Uint8ClampedArray, w: number, h: number, dw: number, dh: number): Uint8ClampedArray {
  const acc = new Float32Array(dw * dh * 4);
  const cnt = new Float32Array(dw * dh);
  const fx = dw / w;
  const fy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor(y * fy));
    for (let x = 0; x < w; x++) {
      const dx = Math.min(dw - 1, Math.floor(x * fx));
      const di = dy * dw + dx;
      const s = (y * w + x) * 4;
      const o = di * 4;
      acc[o] += src[s];
      acc[o + 1] += src[s + 1];
      acc[o + 2] += src[s + 2];
      acc[o + 3] += src[s + 3];
      cnt[di]++;
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++) {
    const n = cnt[i] || 1;
    for (let c = 0; c < 4; c++) out[i * 4 + c] = acc[i * 4 + c] / n;
  }
  return out;
}

/** Max-pool downscale of a single-channel mask (any covered source pixel covers the destination). */
export function downscaleMaskMax(src: Uint8Array, w: number, h: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = dw / w;
  const fy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor(y * fy));
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      if (!v) continue;
      const di = dy * dw + Math.min(dw - 1, Math.floor(x * fx));
      if (v > out[di]) out[di] = v;
    }
  }
  return out;
}

/** Bilinear sample of an RGBA8 image at continuous pixel coords (pixel centres at +0.5). */
export function sampleBilinearRgba8(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Float32Array): void {
  const fx = Math.min(Math.max(x - 0.5, 0), w - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const a = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
    const b = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
    out[c] = a + (b - a) * ty;
  }
}

/** Source-normalized rect → integer pixel rect (outward rounding, clamped, ≥ 1 px). */
export function toPixelRect(r: Rect, W: number, H: number): PixelRect {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(r.x * W)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(r.y * H)));
  const x1 = Math.max(x0 + 1, Math.min(W, Math.ceil((r.x + r.w) * W)));
  const y1 = Math.max(y0 + 1, Math.min(H, Math.ceil((r.y + r.h) * H)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Grow a pixel rect by `m` px on every side, clamped to W×H. */
export function expandRect(r: PixelRect, m: number, W: number, H: number): PixelRect {
  const x0 = Math.max(0, r.x - m);
  const y0 = Math.max(0, r.y - m);
  const x1 = Math.min(W, r.x + r.w + m);
  const y1 = Math.min(H, r.y + r.h + m);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounding box of non-zero mask pixels, or null when empty. */
export function maskBounds(mask: Uint8Array, w: number, h: number): PixelRect | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** sRGB 8-bit value → linear (exported for tests / callers that composite in linear light). */
export const srgb8ToLinear = (v: number): number => srgbToLinear(v / 255);
