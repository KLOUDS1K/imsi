/**
 * Subject localisation (classical saliency). DOM-free.
 *
 *  - Spectral residual (Hou & Zhang, CVPR 2007) on a 64×64 luma thumbnail:
 *    the log-amplitude spectrum minus its local average, transformed back
 *    with the original phase, marks "unexpected" structure.
 *  - Frequency-tuned saliency (Achanta et al., CVPR 2009): distance of the
 *    slightly blurred colour (opponent space) from the image mean colour.
 *  - A centre prior (photographers frame subjects near the middle) and a
 *    boost for face-like skin blobs.
 *
 * The subject box is the 5th–95th weighted percentile extent of the saliency
 * mass above an adaptive threshold.
 */
import type { Rect } from '@/editor/types';
import type { WorkImage } from './buffer';
import { downscalePlane, fitSize } from './buffer';
import type { SkinBlob } from './skin';
import { boxBlur, clamp01, gaussianBlur, meanStd, round2 } from './stats';

const SR = 64;

/* ---------------- FFT (radix-2, in place) ---------------- */

function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function fft2d(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const r = new Float64Array(n);
  const i = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      r[x] = re[y * n + x];
      i[x] = im[y * n + x];
    }
    fft1d(r, i, inverse);
    for (let x = 0; x < n; x++) {
      re[y * n + x] = r[x];
      im[y * n + x] = i[x];
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      r[y] = re[y * n + x];
      i[y] = im[y * n + x];
    }
    fft1d(r, i, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = r[y];
      im[y * n + x] = i[y];
    }
  }
}

/** Spectral-residual saliency of a luma plane, returned at SR×SR. */
function spectralResidual(luma: Float32Array, w: number, h: number): Float32Array {
  const small = downscalePlane(luma, w, h, SR, SR);
  const re = new Float64Array(SR * SR);
  const im = new Float64Array(SR * SR);
  for (let i = 0; i < re.length; i++) re[i] = small[i];
  fft2d(re, im, SR, false);
  const logA = new Float32Array(SR * SR);
  const phase = new Float64Array(SR * SR);
  for (let i = 0; i < re.length; i++) {
    logA[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-9);
    phase[i] = Math.atan2(im[i], re[i]);
  }
  const avg = boxBlur(logA, SR, SR, 1);
  for (let i = 0; i < re.length; i++) {
    const mag = Math.exp(logA[i] - avg[i]);
    re[i] = mag * Math.cos(phase[i]);
    im[i] = mag * Math.sin(phase[i]);
  }
  fft2d(re, im, SR, true);
  const sal = new Float32Array(SR * SR);
  for (let i = 0; i < sal.length; i++) sal[i] = re[i] * re[i] + im[i] * im[i];
  return gaussianBlur(sal, SR, SR, 2.5);
}

/** Nearest-neighbour resample of a small map to another size. */
function resample(src: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / th));
    for (let x = 0; x < tw; x++) out[y * tw + x] = src[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / tw))];
  }
  return out;
}

function normalize(a: Float32Array): void {
  let mx = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
  if (mx > 0) for (let i = 0; i < a.length; i++) a[i] /= mx;
}

export interface SaliencyResult {
  /** Saliency map 0..1 at width × height. */
  map: Float32Array;
  width: number;
  height: number;
  box: Rect;
  confidence: number;
  /** Mean saliency inside / outside the box. */
  inside: number;
  outside: number;
}

export function computeSaliency(img: WorkImage, er: Float32Array, eg: Float32Array, eb: Float32Array, blobs: SkinBlob[]): SaliencyResult {
  const { width: w, height: h } = fitSize(img.width, img.height, 128);
  const n = w * h;
  // Frequency-tuned: opponent colour of the encoded image (downscaled from the work planes).
  const R = downscalePlane(er, img.width, img.height, w, h);
  const G = downscalePlane(eg, img.width, img.height, w, h);
  const B = downscalePlane(eb, img.width, img.height, w, h);
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const Bo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    A[i] = R[i] - G[i];
    Bo[i] = 0.5 * (R[i] + G[i]) - B[i];
  }
  const mL = meanStd(L).mean;
  const mA = meanStd(A).mean;
  const mB = meanStd(Bo).mean;
  const bl = gaussianBlur(L, w, h, 1.2);
  const ba = gaussianBlur(A, w, h, 1.2);
  const bb = gaussianBlur(Bo, w, h, 1.2);
  const ft = new Float32Array(n);
  for (let i = 0; i < n; i++) ft[i] = Math.hypot(bl[i] - mL, 1.4 * (ba[i] - mA), 1.4 * (bb[i] - mB));
  normalize(ft);
  const sr = resample(spectralResidual(img.luma, img.width, img.height), SR, SR, w, h);
  normalize(sr);

  const map = new Float32Array(n);
  const ar = w / h;
  const sx = 0.32 * Math.max(1, ar);
  const sy = 0.32 * Math.max(1, 1 / ar);
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5;
      const centre = Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));
      const i = y * w + x;
      map[i] = (0.6 * ft[i] + 0.4 * sr[i]) * (0.45 + 0.55 * centre);
    }
  }
  // Face-like skin blobs are almost always the subject.
  for (const b of blobs) {
    if (!b.faceLike) continue;
    const x0 = Math.floor(b.box.x * w);
    const y0 = Math.floor(b.box.y * h);
    const x1 = Math.ceil((b.box.x + b.box.w) * w);
    const y1 = Math.ceil((b.box.y + b.box.h) * h);
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) map[y * w + x] += 0.5;
  }
  normalize(map);

  // Adaptive threshold: mean + 0.5·std, then weighted percentile extent.
  const st = meanStd(map);
  const thr = st.mean + 0.5 * st.std;
  const colW = new Float64Array(w);
  const rowW = new Float64Array(h);
  let tot = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = map[y * w + x] - thr;
      if (v <= 0) continue;
      colW[x] += v;
      rowW[y] += v;
      tot += v;
    }
  }
  if (tot <= 0) {
    return { map, width: w, height: h, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, confidence: 0, inside: 0, outside: 0 };
  }
  const extent = (arr: Float64Array, len: number): [number, number] => {
    let acc = 0;
    let lo = 0;
    let hi = len - 1;
    let foundLo = false;
    for (let i = 0; i < len; i++) {
      acc += arr[i];
      if (!foundLo && acc >= 0.05 * tot) {
        lo = i;
        foundLo = true;
      }
      if (acc >= 0.95 * tot) {
        hi = i;
        break;
      }
    }
    return [lo / len, (hi + 1) / len];
  };
  const [bx0, bx1] = extent(colW, w);
  const [by0, by1] = extent(rowW, h);
  const box: Rect = { x: round2(bx0), y: round2(by0), w: round2(Math.max(0.02, bx1 - bx0)), h: round2(Math.max(0.02, by1 - by0)) };
  let sIn = 0;
  let cIn = 0;
  let sOut = 0;
  let cOut = 0;
  for (let y = 0; y < h; y++) {
    const yn = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const xn = (x + 0.5) / w;
      const v = map[y * w + x];
      if (xn >= box.x && xn <= box.x + box.w && yn >= box.y && yn <= box.y + box.h) {
        sIn += v;
        cIn++;
      } else {
        sOut += v;
        cOut++;
      }
    }
  }
  const inside = cIn ? sIn / cIn : 0;
  const outside = cOut ? sOut / cOut : 0;
  const area = box.w * box.h;
  // Confident when the box is clearly more salient than the rest and not the whole frame.
  const contrast = inside > 0 ? clamp01((inside - outside) / inside) : 0;
  const confidence = round2(clamp01(contrast * 1.3) * (area > 0.7 ? 0.5 : 1));
  return { map, width: w, height: h, box, confidence, inside, outside };
}
