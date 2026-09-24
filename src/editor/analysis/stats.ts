/**
 * Numeric helpers for the analysis module: selection/percentiles, separable
 * blurs, gradients and connected components over Float32Array planes.
 * All functions are allocation-light and DOM-free.
 */

/** In-place quickselect: returns the k-th smallest value (0-based). Reorders `a`. */
export function quickSelect(a: Float32Array | Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  if (hi < 0) return 0;
  k = Math.max(0, Math.min(hi, k));
  while (hi > lo) {
    // Median-of-three pivot keeps sorted/structured inputs O(n).
    const mid = (lo + hi) >> 1;
    let x = a[lo];
    let y = a[mid];
    let z = a[hi];
    if (x > y) [x, y] = [y, x];
    if (y > z) [y, z] = [z, y];
    if (x > y) [x, y] = [y, x];
    const pivot = y;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Quantile q ∈ [0,1] of `values` (copied; the input is not modified). */
export function quantile(values: Float32Array | Float64Array, q: number, count = values.length): number {
  if (count <= 0) return 0;
  const tmp = new Float32Array(count);
  for (let i = 0; i < count; i++) tmp[i] = values[i];
  return quickSelect(tmp, Math.round(q * (count - 1)));
}

/**
 * Quantile of a histogram whose bins span [0, 1]. Interpolates linearly inside
 * the bin so the result is continuous.
 */
export function histQuantile(hist: ArrayLike<number>, total: number, q: number): number {
  const bins = hist.length;
  if (total <= 0) return 0;
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < bins; i++) {
    const c = hist[i];
    if (acc + c >= target && c > 0) {
      const t = (target - acc) / c;
      return (i + Math.max(0, Math.min(1, t))) / bins;
    }
    acc += c;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Blurs                                                               */
/* ------------------------------------------------------------------ */

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + (k < 0 ? 0 : k > last ? last : k)];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * inv;
      const add = x + r + 1;
      const sub = x - r;
      acc += src[o + (add > last ? last : add)] - src[o + (sub < 0 ? 0 : sub)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, col: Float32Array): void {
  const inv = 1 / (2 * r + 1);
  const last = h - 1;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = src[y * w + x];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += col[k < 0 ? 0 : k > last ? last : k];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      const add = y + r + 1;
      const sub = y - r;
      acc += col[add > last ? last : add] - col[sub < 0 ? 0 : sub];
    }
  }
}

/** Box blur of radius r (window 2r+1), edge-clamped. `dst` may equal `src`. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, dst = new Float32Array(w * h)): Float32Array {
  if (r <= 0) {
    if (dst !== src) dst.set(src);
    return dst;
  }
  const tmp = new Float32Array(w * h);
  boxH(src, tmp, w, h, r);
  boxV(tmp, dst, w, h, r, new Float32Array(h));
  return dst;
}

/**
 * Gaussian blur. Small sigmas use an exact separable kernel; larger ones use
 * three successive box blurs whose widths are chosen so the total variance
 * equals sigma² (Kovesi, "Fast almost-Gaussian filtering"), which is O(1) per
 * pixel regardless of sigma.
 */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number, dst = new Float32Array(w * h)): Float32Array {
  if (sigma < 0.3) {
    if (dst !== src) dst.set(src);
    return dst;
  }
  if (sigma <= 2.5) return separableGaussian(src, w, h, sigma, dst);
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const tmp = new Float32Array(w * h);
  const col = new Float32Array(h);
  let cur = src;
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wu) - 1) >> 1;
    boxH(cur, tmp, w, h, r);
    boxV(tmp, dst, w, h, r, col);
    cur = dst;
  }
  return dst;
}

function separableGaussian(src: Float32Array, w: number, h: number, sigma: number, dst: Float32Array): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h);
  const lastX = w - 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        const xx = x + j;
        acc += k[j + r] * src[o + (xx < 0 ? 0 : xx > lastX ? lastX : xx)];
      }
      tmp[o + x] = acc;
    }
  }
  const lastY = h - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        const yy = y + j;
        acc += k[j + r] * tmp[(yy < 0 ? 0 : yy > lastY ? lastY : yy) * w + x];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

/* ------------------------------------------------------------------ */
/* Gradients                                                           */
/* ------------------------------------------------------------------ */

/** 3×3 Sobel (divided by 8 so a unit step gives |g| ≈ 0.5 per pixel). Borders are clamped. */
export function sobel(src: Float32Array, w: number, h: number, gx: Float32Array, gy: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const a = src[ym + xm];
      const b = src[ym + x];
      const c = src[ym + xp];
      const d = src[y0 + xm];
      const f = src[y0 + xp];
      const g = src[yp + xm];
      const hh = src[yp + x];
      const i = src[yp + xp];
      gx[y0 + x] = (c + 2 * f + i - a - 2 * d - g) * 0.125;
      gy[y0 + x] = (g + 2 * hh + i - a - 2 * b - c) * 0.125;
    }
  }
}

/** 4-neighbour Laplacian (sum of kernel² = 20). Borders are 0. */
export function laplacian(src: Float32Array, w: number, h: number, out = new Float32Array(w * h)): Float32Array {
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = o + x;
      out[i] = src[i - 1] + src[i + 1] + src[i - w] + src[i + w] - 4 * src[i];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Connected components                                                */
/* ------------------------------------------------------------------ */

export interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** centroid */
  cx: number;
  cy: number;
}

/** 4-connected labelling of a binary mask (non-zero = foreground). Labels start at 1. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps: Component[] = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    const label = next++;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = label;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let sx = 0;
    let sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) {
        labels[p - 1] = label;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) {
        labels[p + 1] = label;
        stack[sp++] = p + 1;
      }
      if (y > 0 && mask[p - w] && !labels[p - w]) {
        labels[p - w] = label;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) {
        labels[p + w] = label;
        stack[sp++] = p + w;
      }
    }
    comps.push({ label, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  return { labels, comps };
}

/** Mean and standard deviation of a plane (optionally over a mask). */
export function meanStd(a: Float32Array, mask?: Uint8Array): { mean: number; std: number; count: number } {
  let s = 0;
  let s2 = 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue;
    const v = a[i];
    s += v;
    s2 += v * v;
    c++;
  }
  if (c === 0) return { mean: 0, std: 0, count: 0 };
  const mean = s / c;
  return { mean, std: Math.sqrt(Math.max(0, s2 / c - mean * mean)), count: c };
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampTo = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round2 = (v: number) => Math.round(v * 100) / 100;
