/**
 * Built-in RAW development of a Bayer mosaic (the "builtin" demosaic option):
 *
 *   raw − black → ÷ (white − black) → × as-shot WB → clip to [0, 1]
 *   → Malvar–He–Cutler demosaic → camera → linear ProPhoto matrix
 *   → Uint16 linear RGBA → EXIF orientation → optional area downscale.
 *
 * Malvar, He & Cutler, "High-quality linear interpolation for demosaicing of
 * Bayer-patterned color images" (ICASSP 2004): bilinear interpolation plus a
 * gain-corrected Laplacian of the channel that IS sampled at the pixel, via
 * fixed 5×5 kernels (all /8):
 *   G at R/B:            4·C + 2·(N,S,E,W) − 1·(N2,S2,E2,W2)
 *   R/B at G, same row:  5·C + 4·(E,W) − 1·(E2,W2) − 1·(diagonals) + ½·(N2,S2)
 *   R/B at G, same col:  transpose of the above
 *   R at B / B at R:     6·C + 2·(diagonals) − 3/2·(N2,S2,E2,W2)
 * The mosaic is padded by 2 px with CFA-parity-preserving mirroring so the
 * kernels need no bounds checks.
 *
 * When a proxy of at most half the sensor size is wanted, each 2×2 CFA cell
 * becomes one pixel (R, mean G, B) instead — the classic "half-size" mode.
 */
import { applyOrientation, downscale } from './pixels';
import type { PixelBuffer } from '../types';

export interface BayerJob {
  raw: Uint16Array;
  rawWidth: number;
  rawHeight: number;
  /** Visible area inside the raw frame. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** CFA colour (0 R, 1 G, 2 B) at visible (row&1, col&1): [c00, c01, c10, c11]. */
  cfa: [number, number, number, number];
  black: number;
  white: number;
  /** Per-channel (R, G, B) white-balance multipliers, smallest = 1. */
  wb: [number, number, number];
  /** Camera RGB → output (row-major 3×3). */
  matrix: number[];
  /** Superpixel half-size development (fast proxy). */
  half: boolean;
  /** EXIF orientation to apply (1..8). */
  orientation: number;
  maxSize?: number;
}

/** Develop a Bayer mosaic to Uint16 LINEAR RGBA (primaries = the matrix output). */
export function developBayer(job: BayerJob): PixelBuffer {
  const img = job.half ? superpixel(job) : malvar(job);
  const oriented = applyOrientation(img, job.orientation);
  return job.maxSize ? downscale(oriented, job.maxSize) : oriented;
}

/** Normalized, white-balanced, clipped value of raw pixel at visible (x, y). */
function normalizer(job: BayerJob): (x: number, y: number) => number {
  const { raw, rawWidth, left, top, black, cfa, wb } = job;
  const range = Math.max(1, job.white - black);
  const k = [wb[0] / range, wb[1] / range, wb[2] / range];
  return (x, y) => {
    const v = (raw[(y + top) * rawWidth + x + left] - black) * k[cfa[((y & 1) << 1) | (x & 1)]];
    return v <= 0 ? 0 : v >= 1 ? 1 : v;
  };
}

/** Build the normalized mosaic padded by 2 px (mirror about the edge pixel keeps CFA parity). */
function paddedMosaic(job: BayerJob): { m: Float32Array; P: number } {
  const { width: W, height: H } = job;
  const P = W + 4;
  const m = new Float32Array(P * (H + 4));
  const val = normalizer(job);
  const mirror = (i: number, n: number): number => (i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i);
  for (let y = -2; y < H + 2; y++) {
    const sy = mirror(y, H);
    const row = (y + 2) * P;
    if (y >= 0 && y < H) {
      for (let x = 0; x < W; x++) m[row + x + 2] = val(x, sy);
      m[row] = val(2, sy);
      m[row + 1] = val(1, sy);
      m[row + W + 2] = val(W - 2 >= 0 ? W - 2 : 0, sy);
      m[row + W + 3] = val(W - 3 >= 0 ? W - 3 : 0, sy);
    } else {
      for (let x = -2; x < W + 2; x++) m[row + x + 2] = val(mirror(x, W), sy);
    }
  }
  return { m, P };
}

function malvar(job: BayerJob): PixelBuffer {
  const { width: W, height: H, cfa, matrix: M } = job;
  if (W < 3 || H < 3) return superpixelOrTiny(job);
  const { m, P } = paddedMosaic(job);
  const out = new Uint16Array(W * H * 4);
  const P2 = 2 * P;
  const q = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 65535 : (v * 65535 + 0.5) | 0);
  for (let y = 0; y < H; y++) {
    const ry = (y & 1) << 1;
    let i = (y + 2) * P + 2;
    let o = y * W * 4;
    for (let x = 0; x < W; x++, i++, o += 4) {
      const c = cfa[ry | (x & 1)];
      const C = m[i];
      const N = m[i - P], S = m[i + P], E = m[i + 1], Wv = m[i - 1];
      const N2 = m[i - P2], S2 = m[i + P2], E2 = m[i + 2], W2 = m[i - 2];
      let r: number, g: number, b: number;
      if (c === 1) {
        const diag = m[i - P - 1] + m[i - P + 1] + m[i + P - 1] + m[i + P + 1];
        // Horizontal-neighbour colour at this green site.
        const hc = cfa[ry | ((x + 1) & 1)];
        const horiz = (5 * C + 4 * (E + Wv) - (E2 + W2) - diag + 0.5 * (N2 + S2)) * 0.125;
        const vert = (5 * C + 4 * (N + S) - (N2 + S2) - diag + 0.5 * (E2 + W2)) * 0.125;
        g = C;
        if (hc === 0) {
          r = horiz;
          b = vert;
        } else {
          b = horiz;
          r = vert;
        }
      } else {
        const axial2 = N2 + S2 + E2 + W2;
        g = (4 * C + 2 * (N + S + E + Wv) - axial2) * 0.125;
        const diag = m[i - P - 1] + m[i - P + 1] + m[i + P - 1] + m[i + P + 1];
        const other = (6 * C + 2 * diag - 1.5 * axial2) * 0.125;
        if (c === 0) {
          r = C;
          b = other;
        } else {
          b = C;
          r = other;
        }
      }
      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;
      out[o] = q(M[0] * r + M[1] * g + M[2] * b);
      out[o + 1] = q(M[3] * r + M[4] * g + M[5] * b);
      out[o + 2] = q(M[6] * r + M[7] * g + M[8] * b);
      out[o + 3] = 65535;
    }
  }
  return { width: W, height: H, data: out, transfer: 'linear' };
}

function superpixelOrTiny(job: BayerJob): PixelBuffer {
  if (job.width >= 2 && job.height >= 2) return superpixel(job);
  const out = new Uint16Array(4);
  out[3] = 65535;
  return { width: 1, height: 1, data: out, transfer: 'linear' };
}

/** 2×2 CFA cell → one RGB pixel (R, mean of the two G, B). */
function superpixel(job: BayerJob): PixelBuffer {
  const { cfa, matrix: M } = job;
  const W = job.width >> 1;
  const H = job.height >> 1;
  const val = normalizer(job);
  const out = new Uint16Array(W * H * 4);
  const q = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 65535 : (v * 65535 + 0.5) | 0);
  const acc = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      acc[0] = acc[1] = acc[2] = 0;
      for (let k = 0; k < 4; k++) acc[cfa[k]] += val(2 * x + (k & 1), 2 * y + (k >> 1));
      const r = acc[0];
      const g = acc[1] * 0.5;
      const b = acc[2];
      const o = (y * W + x) * 4;
      out[o] = q(M[0] * r + M[1] * g + M[2] * b);
      out[o + 1] = q(M[3] * r + M[4] * g + M[5] * b);
      out[o + 2] = q(M[6] * r + M[7] * g + M[8] * b);
      out[o + 3] = 65535;
    }
  }
  return { width: W, height: H, data: out, transfer: 'linear' };
}

/**
 * Black level estimated from the masked (optical black) border of the raw
 * frame — used when LibRaw reports 0. Returns 0 when there is no usable border.
 */
export function estimateMaskedBlack(raw: Uint16Array, rawWidth: number, rawHeight: number, left: number, top: number): number {
  const samples: number[] = [];
  const step = 7;
  if (left >= 8) {
    for (let y = top; y < rawHeight; y += step) for (let x = 2; x < left - 2; x += 3) samples.push(raw[y * rawWidth + x]);
  }
  if (top >= 8 && samples.length < 64) {
    for (let y = 2; y < top - 2; y += 3) for (let x = left; x < rawWidth; x += step) samples.push(raw[y * rawWidth + x]);
  }
  if (samples.length < 32) return 0;
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}
