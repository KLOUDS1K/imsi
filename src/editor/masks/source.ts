/**
 * Per-source feature planes used by the color-range and luminance-range
 * components: OKLab (L, a, b) and CIE L* ÷ 100, computed once per source buffer
 * (cached by buffer identity) at ≤ FEATURE_MAX_SIDE so memory stays bounded,
 * then sampled bilinearly at the requested mask size.
 */
import type { PixelBuffer, RGB } from '@/editor/types';
import { linearToSrgb, srgbToLinear } from '@/editor/color/math';

export const FEATURE_MAX_SIDE = 1024;

export interface SourceFeatures {
  width: number;
  height: number;
  /** OKLab, interleaved L,a,b. */
  lab: Float32Array;
  /** CIE L* / 100 (perceptual lightness 0..1). */
  lstar: Float32Array;
}

const LIN_LUT_SIZE = 4096;
/** sRGB-encoded 0..1 (quantized to 12 bits) → linear. */
const SRGB_TO_LIN = (() => {
  const t = new Float32Array(LIN_LUT_SIZE + 1);
  for (let i = 0; i <= LIN_LUT_SIZE; i++) t[i] = srgbToLinear(i / LIN_LUT_SIZE);
  return t;
})();

function linFromSrgb(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const f = x * LIN_LUT_SIZE;
  const i = f | 0;
  const t = f - i;
  const a = SRGB_TO_LIN[i]!;
  return i >= LIN_LUT_SIZE ? a : a + (SRGB_TO_LIN[i + 1]! - a) * t;
}

/** Linear sRGB → OKLab. */
export function linearToOklab(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** sRGB-encoded (0..1) color → OKLab. */
export function srgbToOklab(c: RGB): [number, number, number] {
  const out = [0, 0, 0];
  linearToOklab(linFromSrgb(c[0]), linFromSrgb(c[1]), linFromSrgb(c[2]), out);
  return [out[0]!, out[1]!, out[2]!];
}

/** Relative luminance Y (linear) → CIE L* ÷ 100. */
export function lstarFromY(y: number): number {
  const f = y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27 * y + 16) / 116;
  return Math.max(0, Math.min(1, (116 * f - 16) / 100));
}

/**
 * Area-average `px` down to at most `maxSide` on the long edge and return
 * sRGB-ENCODED float RGB (3 channels), whatever the input type/transfer.
 */
export function toSrgbFloat(px: PixelBuffer, maxSide: number): { width: number; height: number; rgb: Float32Array } {
  const { width: W, height: H, data } = px;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const norm = data instanceof Uint16Array ? 1 / 65535 : data instanceof Float32Array ? 1 : 1 / 255;
  const linear = px.transfer === 'linear';
  const rgb = new Float32Array(w * h * 3);
  // Box filter: each output pixel averages the source pixels whose centres fall in it.
  const sumR = new Float64Array(w), sumG = new Float64Array(w), sumB = new Float64Array(w), cnt = new Float64Array(w);
  const xMap = new Int32Array(W);
  for (let x = 0; x < W; x++) xMap[x] = Math.min(w - 1, Math.floor(((x + 0.5) * w) / W));
  let sy = 0;
  for (let y = 0; y < h; y++) {
    const yEnd = y === h - 1 ? H : Math.max(sy + 1, Math.round(((y + 1) * H) / h));
    sumR.fill(0); sumG.fill(0); sumB.fill(0); cnt.fill(0);
    for (; sy < yEnd; sy++) {
      let i = sy * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        const ox = xMap[x]!;
        sumR[ox]! += data[i]!;
        sumG[ox]! += data[i + 1]!;
        sumB[ox]! += data[i + 2]!;
        cnt[ox]!++;
      }
    }
    for (let x = 0; x < w; x++) {
      const k = cnt[x]! > 0 ? norm / cnt[x]! : 0;
      let r = sumR[x]! * k, g = sumG[x]! * k, b = sumB[x]! * k;
      if (linear) {
        r = linearToSrgb(Math.min(1, r));
        g = linearToSrgb(Math.min(1, g));
        b = linearToSrgb(Math.min(1, b));
      }
      const o = (y * w + x) * 3;
      rgb[o] = r > 1 ? 1 : r < 0 ? 0 : r;
      rgb[o + 1] = g > 1 ? 1 : g < 0 ? 0 : g;
      rgb[o + 2] = b > 1 ? 1 : b < 0 ? 0 : b;
    }
  }
  return { width: w, height: h, rgb };
}

const cache = new WeakMap<object, SourceFeatures>();

export function getSourceFeatures(px: PixelBuffer): SourceFeatures {
  const hit = cache.get(px.data);
  if (hit) return hit;
  const { width, height, rgb } = toSrgbFloat(px, FEATURE_MAX_SIDE);
  const n = width * height;
  const lab = new Float32Array(n * 3);
  const lstar = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = linFromSrgb(rgb[i * 3]!);
    const g = linFromSrgb(rgb[i * 3 + 1]!);
    const b = linFromSrgb(rgb[i * 3 + 2]!);
    linearToOklab(r, g, b, lab, i * 3);
    lstar[i] = lstarFromY(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const f = { width, height, lab, lstar };
  cache.set(px.data, f);
  return f;
}

/**
 * Bilinear sampling setup: for output coordinate i in [0, outN) returns the
 * lower source index and weight of the upper one (pixel-centre aligned).
 */
export function bilinearAxis(outN: number, srcN: number): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(outN);
  const i1 = new Int32Array(outN);
  const t = new Float32Array(outN);
  const s = srcN / outN;
  for (let i = 0; i < outN; i++) {
    let f = (i + 0.5) * s - 0.5;
    if (f < 0) f = 0;
    if (f > srcN - 1) f = srcN - 1;
    const a = Math.floor(f);
    i0[i] = a;
    i1[i] = Math.min(srcN - 1, a + 1);
    t[i] = f - a;
  }
  return { i0, i1, t };
}

/** Bilinear resample of a single-channel 8-bit plane to w×h (into `out`). */
export function resamplePlane(src: Uint8Array, sw: number, sh: number, w: number, h: number, out: Uint8Array): void {
  if (sw === w && sh === h) {
    out.set(src.subarray(0, w * h));
    return;
  }
  const ax = bilinearAxis(w, sw);
  const ay = bilinearAxis(h, sh);
  for (let y = 0; y < h; y++) {
    const r0 = ay.i0[y]! * sw;
    const r1 = ay.i1[y]! * sw;
    const ty = ay.t[y]!;
    let o = y * w;
    for (let x = 0; x < w; x++, o++) {
      const x0 = ax.i0[x]!, x1 = ax.i1[x]!, tx = ax.t[x]!;
      const top = src[r0 + x0]! + (src[r0 + x1]! - src[r0 + x0]!) * tx;
      const bot = src[r1 + x0]! + (src[r1 + x1]! - src[r1 + x0]!) * tx;
      out[o] = (top + (bot - top) * ty + 0.5) | 0;
    }
  }
}
