/**
 * GrabCut-lite: iterative foreground/background colour-model estimation with
 * edge-aware smoothing, a cheap stand-in for GrabCut's GMM + graph cut:
 *
 *   repeat:
 *     colour models  = soft 3-D colour histograms (16³ bins, blurred) of the
 *                      current fg/bg posterior
 *     unary          = log p(c|fg) − log p(c|bg) + w · logit(prior)
 *     mean field     = a few sweeps of q ← σ(unary + β · Σ w_ij (2q_j − 1) / Σ w_ij)
 *                      with contrast-sensitive weights w_ij = exp(−|ΔLab|² / 2σ²)
 */
import type { Img } from './image';

export interface GrabCutOptions {
  iterations?: number;
  /** Weight of the spatial prior logit in the unary term. */
  priorWeight?: number;
  /** Pairwise strength β. */
  smooth?: number;
  hardFg?: Uint8Array;
  hardBg?: Uint8Array;
}

const Q = 16;
const NB = Q * Q * Q;

function blurHist(h: Float64Array): void {
  const tmp = new Float64Array(NB);
  const strides = [1, Q, Q * Q];
  for (const s of strides) {
    tmp.fill(0);
    for (let i = 0; i < NB; i++) {
      const c = ((i / s) | 0) % Q;
      let v = h[i]! * 2;
      if (c > 0) v += h[i - s]!;
      if (c < Q - 1) v += h[i + s]!;
      tmp[i] = v / 4;
    }
    h.set(tmp);
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => {
  const q = p < 0.02 ? 0.02 : p > 0.98 ? 0.98 : p;
  return Math.log(q / (1 - q));
};

export function grabCutLite(img: Img, prior: Float32Array, opts: GrabCutOptions = {}): Float32Array {
  const { w, h, n, r, g, b, L, A, B } = img;
  const iterations = opts.iterations ?? 5;
  const pw = opts.priorWeight ?? 0.6;
  const beta = opts.smooth ?? 2.2;
  const bin = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const qr = Math.min(Q - 1, (r[i]! * Q) | 0), qg = Math.min(Q - 1, (g[i]! * Q) | 0), qb = Math.min(Q - 1, (b[i]! * Q) | 0);
    bin[i] = qr * Q * Q + qg * Q + qb;
  }
  // Contrast-sensitive pairwise weights to the right and down neighbours.
  let meanD = 0;
  const dR = new Float32Array(n), dD = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) {
        const d = (L[i]! - L[i + 1]!) ** 2 + (A[i]! - A[i + 1]!) ** 2 + (B[i]! - B[i + 1]!) ** 2;
        dR[i] = d;
        meanD += d;
      }
      if (y < h - 1) {
        const d = (L[i]! - L[i + w]!) ** 2 + (A[i]! - A[i + w]!) ** 2 + (B[i]! - B[i + w]!) ** 2;
        dD[i] = d;
        meanD += d;
      }
    }
  meanD = Math.max(1e-5, meanD / (2 * n));
  const k = 1 / (2 * meanD);
  for (let i = 0; i < n; i++) {
    dR[i] = Math.exp(-dR[i]! * k);
    dD[i] = Math.exp(-dD[i]! * k);
  }
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = prior[i]!;
  const priorLogit = new Float32Array(n);
  for (let i = 0; i < n; i++) priorLogit[i] = pw * logit(prior[i]!);
  const hf = new Float64Array(NB), hb = new Float64Array(NB);
  const unary = new Float32Array(n);
  const next = new Float32Array(n);
  for (let it = 0; it < iterations; it++) {
    hf.fill(0);
    hb.fill(0);
    for (let i = 0; i < n; i++) {
      hf[bin[i]!]! += q[i]!;
      hb[bin[i]!]! += 1 - q[i]!;
    }
    blurHist(hf);
    blurHist(hb);
    let sf = 0, sb = 0;
    for (let c = 0; c < NB; c++) { sf += hf[c]!; sb += hb[c]!; }
    const ef = 1e-4 / NB, eb = 1e-4 / NB;
    for (let c = 0; c < NB; c++) {
      hf[c] = Math.log(hf[c]! / Math.max(sf, 1e-9) + ef);
      hb[c] = Math.log(hb[c]! / Math.max(sb, 1e-9) + eb);
    }
    for (let i = 0; i < n; i++) {
      let u = hf[bin[i]!]! - hb[bin[i]!]!;
      u = u > 5 ? 5 : u < -5 ? -5 : u;
      unary[i] = u + priorLogit[i]!;
    }
    for (let i = 0; i < n; i++) q[i] = sigmoid(unary[i]!);
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          let s = 0, ws = 0;
          if (x > 0) { const wt = dR[i - 1]!; s += wt * (2 * q[i - 1]! - 1); ws += wt; }
          if (x < w - 1) { const wt = dR[i]!; s += wt * (2 * q[i + 1]! - 1); ws += wt; }
          if (y > 0) { const wt = dD[i - w]!; s += wt * (2 * q[i - w]! - 1); ws += wt; }
          if (y < h - 1) { const wt = dD[i]!; s += wt * (2 * q[i + w]! - 1); ws += wt; }
          next[i] = sigmoid(unary[i]! + (ws > 1e-6 ? (beta * s) / Math.max(ws, 0.5) * Math.min(1, ws / 2) : 0));
        }
      q.set(next);
      if (opts.hardFg) for (let i = 0; i < n; i++) if (opts.hardFg[i]) q[i] = 1;
      if (opts.hardBg) for (let i = 0; i < n; i++) if (opts.hardBg[i]) q[i] = 0;
    }
  }
  return q;
}
