/**
 * Image preparation + small numeric helpers shared by the heuristic
 * segmenters. Everything works on planar Float32 arrays at a reduced
 * "work" resolution; the final masks are upsampled with a guided filter.
 */
import type { PixelBuffer } from '@/editor/types';

export interface Img {
  w: number;
  h: number;
  n: number;
  /** sRGB-encoded 0..1 planes. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** OKLab planes. */
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  /** OKLab chroma. */
  C: Float32Array;
  /** Sobel gradient magnitude of OKLab (L + 0.5·chroma channels). */
  grad: Float32Array;
}

const LIN = (() => {
  const t = new Float32Array(1025);
  for (let i = 0; i <= 1024; i++) {
    const v = i / 1024;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();
export const toLinear = (v: number) => LIN[Math.max(0, Math.min(1024, (v * 1024 + 0.5) | 0))]!;
const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Area-average an RGBA buffer (any type/transfer) to ≤ maxSide, returning sRGB-encoded planes. */
export function downsampleRgb(px: PixelBuffer, maxSide: number): { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array } {
  const { width: W, height: H, data } = px;
  const s = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const norm = data instanceof Uint16Array ? 1 / 65535 : data instanceof Float32Array ? 1 : 1 / 255;
  const lin = px.transfer === 'linear';
  const r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  const xm = new Int32Array(W);
  for (let x = 0; x < W; x++) xm[x] = Math.min(w - 1, ((x + 0.5) * w / W) | 0);
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, ((y + 0.5) * h / H) | 0) * w;
    let i = y * W * 4;
    for (let x = 0; x < W; x++, i += 4) {
      const o = row + xm[x]!;
      r[o]! += data[i]!;
      g[o]! += data[i + 1]!;
      b[o]! += data[i + 2]!;
      cnt[o]!++;
    }
  }
  for (let o = 0; o < w * h; o++) {
    const k = cnt[o]! > 0 ? norm / cnt[o]! : 0;
    let rr = r[o]! * k, gg = g[o]! * k, bb = b[o]! * k;
    if (lin) {
      rr = encode(Math.max(0, Math.min(1, rr)));
      gg = encode(Math.max(0, Math.min(1, gg)));
      bb = encode(Math.max(0, Math.min(1, bb)));
    }
    r[o] = Math.max(0, Math.min(1, rr));
    g[o] = Math.max(0, Math.min(1, gg));
    b[o] = Math.max(0, Math.min(1, bb));
  }
  return { w, h, r, g, b };
}

export function prepare(px: PixelBuffer, maxSide: number): Img {
  const { w, h, r, g, b } = downsampleRgb(px, maxSide);
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lr = toLinear(r[i]!), lg = toLinear(g[i]!), lb = toLinear(b[i]!);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    L[i] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    A[i] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    B[i] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    C[i] = Math.hypot(A[i]!, B[i]!);
  }
  const grad = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const P = c === 0 ? L : c === 1 ? A : B;
        const gx = P[ym + xp]! + 2 * P[y0 + xp]! + P[yp + xp]! - P[ym + xm]! - 2 * P[y0 + xm]! - P[yp + xm]!;
        const gy = P[yp + xm]! + 2 * P[yp + x]! + P[yp + xp]! - P[ym + xm]! - 2 * P[ym + x]! - P[ym + xp]!;
        sum += (c === 0 ? 1 : 0.5) * (gx * gx + gy * gy);
      }
      grad[y0 + x] = Math.sqrt(sum) / 4;
    }
  }
  return { w, h, n, r, g, b, L, A, B, C, grad };
}

/** Separable box mean with radius r (edge windows normalized by their true size). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, out: Float32Array = new Float32Array(w * h)): Float32Array {
  if (r <= 0) {
    out.set(src);
    return out;
  }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[o + x]!;
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[o + x] = acc / (Math.min(hi, w - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 < w) acc += src[o + hi + 1]!;
      if (lo >= 0) acc -= src[o + lo]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      const lo = y - r, hi = y + r;
      out[y * w + x] = acc / (Math.min(hi, h - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 < h) acc += tmp[(hi + 1) * w + x]!;
      if (lo >= 0) acc -= tmp[lo * w + x]!;
    }
  }
  return out;
}

/** ~Gaussian blur by three box passes (variance of 3 boxes of radius r = ((2r+1)² − 1) / 4). */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = boxBlur(src, w, h, r);
  const b = boxBlur(a, w, h, r);
  return boxBlur(b, w, h, r, a);
}

export function normalize(a: Float32Array, lowPct = 0, highPct = 1): Float32Array {
  const lo = lowPct > 0 ? percentile(a, lowPct) : min(a);
  const hi = highPct < 1 ? percentile(a, highPct) : max(a);
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(1, (a[i]! - lo) * k));
  return a;
}

export function min(a: Float32Array): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! < m) m = a[i]!;
  return m;
}
export function max(a: Float32Array): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}
export function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return a.length ? s / a.length : 0;
}

/** Percentile (0..1) via a 1024-bin histogram over [min, max]. */
export function percentile(a: Float32Array, p: number): number {
  const lo = min(a), hi = max(a);
  if (!(hi > lo)) return lo;
  const bins = new Uint32Array(1024);
  const k = 1023 / (hi - lo);
  for (let i = 0; i < a.length; i++) bins[((a[i]! - lo) * k) | 0]!++;
  const target = p * a.length;
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += bins[i]!;
    if (acc >= target) return lo + i / k;
  }
  return hi;
}

/** Otsu threshold of values in [0,1]. */
export function otsu(a: Float32Array): number {
  const bins = new Float64Array(256);
  for (let i = 0; i < a.length; i++) bins[Math.max(0, Math.min(255, (a[i]! * 255) | 0))]!++;
  const total = a.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * bins[i]!;
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += bins[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * bins[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) {
      best = v;
      thr = t;
    }
  }
  return (thr + 0.5) / 255;
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Bilinear resample of a float plane. */
export function resample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const sx = sw / w, sy = sh / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    fy = fy < 0 ? 0 : fy > sh - 1 ? sh - 1 : fy;
    const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      fx = fx < 0 ? 0 : fx > sw - 1 ? sw - 1 : fx;
      const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0]! + (src[y0 * sw + x1]! - src[y0 * sw + x0]!) * tx;
      const b = src[y1 * sw + x0]! + (src[y1 * sw + x1]! - src[y1 * sw + x0]!) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

export function toU8(a: Float32Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, Math.min(255, a[i]! * 255 + 0.5)) | 0;
  return out;
}
