/**
 * Saliency (heuristic) — a blend of classical cues:
 * - spectral residual (Hou & Zhang 2007) on a 64×64 luminance thumbnail,
 * - frequency-tuned contrast (Achanta 2009): |mean Lab − blurred Lab|,
 * - boundary prior: colour distance to clusters of border pixels (the
 *   border is usually background),
 * - centre prior and a skin boost (people are usually the subject).
 */
import { boxBlur, gaussBlur, normalize, resample, smoothstep, type Img } from './image';

/** In-place iterative radix-2 FFT on (re, im) of length n (power of two). */
function fft1(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n; }
}

/** 2-D FFT on an N×N complex grid (row-major). */
export function fft2(re: Float64Array, im: Float64Array, N: number, inverse: boolean): void {
  const r = new Float64Array(N), i = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    r.set(re.subarray(y * N, y * N + N));
    i.set(im.subarray(y * N, y * N + N));
    fft1(r, i, inverse);
    re.set(r, y * N);
    im.set(i, y * N);
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { r[y] = re[y * N + x]!; i[y] = im[y * N + x]!; }
    fft1(r, i, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = r[y]!; im[y * N + x] = i[y]!; }
  }
}

export function spectralResidual(img: Img): Float32Array {
  const N = 64;
  const small = resample(img.L, img.w, img.h, N, N);
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) re[k] = small[k]!;
  fft2(re, im, N, false);
  const logA = new Float32Array(N * N), phase = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    logA[k] = Math.log(Math.hypot(re[k]!, im[k]!) + 1e-9);
    phase[k] = Math.atan2(im[k]!, re[k]!);
  }
  const avg = boxBlur(logA, N, N, 1);
  for (let k = 0; k < N * N; k++) {
    const m = Math.exp(logA[k]! - avg[k]!);
    re[k] = m * Math.cos(phase[k]!);
    im[k] = m * Math.sin(phase[k]!);
  }
  fft2(re, im, N, true);
  const s = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) s[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  const blurred = gaussBlur(s, N, N, 2.5);
  return normalize(resample(blurred, N, N, img.w, img.h), 0, 0.995);
}

export function frequencyTuned(img: Img): Float32Array {
  const { w, h, n, L, A, B } = img;
  let mL = 0, mA = 0, mB = 0;
  for (let i = 0; i < n; i++) { mL += L[i]!; mA += A[i]!; mB += B[i]!; }
  mL /= n; mA /= n; mB /= n;
  const bl = gaussBlur(L, w, h, 1.5), ba = gaussBlur(A, w, h, 1.5), bb = gaussBlur(B, w, h, 1.5);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.hypot(bl[i]! - mL, 1.4 * (ba[i]! - mA), 1.4 * (bb[i]! - mB));
  return normalize(s, 0, 0.995);
}

/** Distance of each pixel's colour to the nearest border-colour cluster. */
export function boundaryContrast(img: Img): Float32Array {
  const { w, h, n, L, A, B } = img;
  // Quantize border colours on a coarse OKLab grid; bins become clusters.
  const bins = new Map<number, { l: number; a: number; b: number; c: number }>();
  const add = (i: number) => {
    const key = (Math.round(L[i]! * 12) * 64 + Math.round(A[i]! * 30 + 20)) * 64 + Math.round(B[i]! * 30 + 20);
    const e = bins.get(key);
    if (e) { e.l += L[i]!; e.a += A[i]!; e.b += B[i]!; e.c++; }
    else bins.set(key, { l: L[i]!, a: A[i]!, b: B[i]!, c: 1 });
  };
  const m = Math.max(1, Math.round(Math.min(w, h) * 0.03));
  let total = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x < m || y < m || x >= w - m || y >= h - m) { add(y * w + x); total++; }
  const clusters = [...bins.values()].filter((e) => e.c >= total * 0.01).map((e) => [e.l / e.c, e.a / e.c, e.b / e.c] as const);
  const s = new Float32Array(n);
  if (!clusters.length) return s.fill(0.5);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (const [cl, ca, cb] of clusters) {
      const d = (L[i]! - cl) ** 2 + 1.5 * ((A[i]! - ca) ** 2 + (B[i]! - cb) ** 2);
      if (d < best) best = d;
    }
    s[i] = smoothstep(0.03, 0.2, Math.sqrt(best));
  }
  return s;
}

export function centrePrior(w: number, h: number, sigma = 0.32): Float32Array {
  const s = new Float32Array(w * h);
  const k = 1 / (2 * sigma * sigma);
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5;
      s[y * w + x] = Math.exp(-(dx * dx + dy * dy) * k);
    }
  }
  return s;
}

/** Combined saliency 0..1 at work resolution. `skin` (0..1) optional boost. */
export function saliency(img: Img, skin?: Float32Array): Float32Array {
  const sr = spectralResidual(img);
  const ft = frequencyTuned(img);
  const bc = boundaryContrast(img);
  const cp = centrePrior(img.w, img.h);
  const s = new Float32Array(img.n);
  for (let i = 0; i < img.n; i++) {
    const v = (0.2 * sr[i]! + 0.3 * ft[i]! + 0.5 * bc[i]!) * (0.35 + 0.65 * cp[i]!);
    s[i] = v + (skin ? 0.25 * skin[i]! * cp[i]! : 0);
  }
  return normalize(gaussBlur(s, img.w, img.h, 1), 0, 0.99);
}
