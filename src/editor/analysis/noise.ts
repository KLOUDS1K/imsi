/**
 * Noise and sharpness estimation on a perceptual luma plane. DOM-free.
 *
 * Noise — Immerkær's operator N = [1 -2 1; -2 4 -2; 1 -2 1] (the difference of
 * two Laplacians) cancels image structure up to second order, so on smooth
 * areas its response is pure noise with variance 36·σ². The plane is split
 * into 16×16 blocks; textured blocks inflate their estimate, so a low
 * quantile of the per-block estimates (with a small bias correction for the
 * quantile of a χ-distribution) measures the noise of the flat regions.
 *
 * Sharpness — variance of the Laplacian on edge pixels, normalised by the mean
 * gradient magnitude there. For an edge blurred by a Gaussian of width s, the
 * gradient scales with 1/s and the Laplacian with 1/s², so the ratio is
 * ∝ 1/s and independent of edge contrast. The Laplacian variance of the
 * measured noise (20·σ² for the 4-neighbour kernel) is subtracted first so
 * grain does not read as detail.
 */
import type { LumaPlane } from './buffer';
import { clamp01, laplacian, quantile, sobel } from './stats';

const BLOCK = 16;
/** Quantile of the block estimates that represents the flat areas. */
const NOISE_Q = 0.2;
/**
 * The q-quantile of block σ estimates is biased low for pure noise; this
 * factor was calibrated on synthetic Gaussian noise (see
 * tests/unit/analysis/noise-sharpness.test.ts).
 */
const NOISE_Q_BIAS = 1.035;

export function noiseSigma(p: LumaPlane): number {
  const { width: w, height: h, data } = p;
  if (w < 8 || h < 8) return 0;
  const bw = Math.floor((w - 2) / BLOCK);
  const bh = Math.floor((h - 2) / BLOCK);
  const est = new Float32Array(Math.max(1, bw * bh));
  let count = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s2 = 0;
      let mean = 0;
      let clipped = 0;
      const ys = 1 + by * BLOCK;
      const xs = 1 + bx * BLOCK;
      for (let y = ys; y < ys + BLOCK; y++) {
        const o = y * w;
        for (let x = xs; x < xs + BLOCK; x++) {
          const i = o + x;
          const c = data[i];
          mean += c;
          if (c <= 0.002 || c >= 0.998) clipped++;
          const m =
            data[i - w - 1] - 2 * data[i - w] + data[i - w + 1] - 2 * data[i - 1] + 4 * c - 2 * data[i + 1] + data[i + w - 1] - 2 * data[i + w] + data[i + w + 1];
          s2 += m * m;
        }
      }
      mean /= BLOCK * BLOCK;
      // Clipped or nearly black/white blocks carry no measurable noise.
      if (clipped > (BLOCK * BLOCK) / 8 || mean < 0.03 || mean > 0.97) continue;
      est[count++] = Math.sqrt(s2 / (BLOCK * BLOCK) / 36);
    }
  }
  if (count === 0) return 0;
  return quantile(est, NOISE_Q, count) * NOISE_Q_BIAS;
}

/** Maps σ (0..1 units) and optional ISO to a 0..100 noise level. */
export function noiseLevel(sigma: number, iso?: number): number {
  const s255 = sigma * 255;
  const measured = 100 * (1 - Math.exp(-s255 / 5));
  if (!iso || !(iso > 0)) return Math.round(measured);
  const isoLevel = Math.max(0, Math.min(100, 22 * Math.log2(iso / 100)));
  return Math.round(0.72 * measured + 0.28 * isoLevel);
}

export interface SharpnessMeasure {
  /** Contrast-invariant Laplacian/gradient ratio (per pixel). */
  ratio: number;
  /** Number of edge pixels that contributed. */
  edges: number;
}

export interface GradientPlanes {
  width: number;
  height: number;
  mag: Float32Array;
  lap: Float32Array;
}

export function gradientPlanes(p: LumaPlane): GradientPlanes {
  const { width: w, height: h, data } = p;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  sobel(data, w, h, gx, gy);
  const mag = gx; // reuse
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  return { width: w, height: h, mag, lap: laplacian(data, w, h) };
}

/** Sharpness ratio over the whole plane or a normalised sub-rectangle. */
export function sharpnessRatio(gp: GradientPlanes, sigmaNoise: number, rect?: { x: number; y: number; w: number; h: number }, magThr?: number): SharpnessMeasure {
  const { width: w, height: h, mag, lap } = gp;
  const x0 = rect ? Math.max(1, Math.floor(rect.x * w)) : 1;
  const y0 = rect ? Math.max(1, Math.floor(rect.y * h)) : 1;
  const x1 = rect ? Math.min(w - 1, Math.ceil((rect.x + rect.w) * w)) : w - 1;
  const y1 = rect ? Math.min(h - 1, Math.ceil((rect.y + rect.h) * h)) : h - 1;
  const thr = magThr ?? edgeThreshold(gp, sigmaNoise);
  let s2 = 0;
  let sm = 0;
  let c = 0;
  for (let y = y0; y < y1; y++) {
    const o = y * w;
    for (let x = x0; x < x1; x++) {
      const i = o + x;
      if (mag[i] < thr) continue;
      const l = lap[i];
      s2 += l * l;
      sm += mag[i];
      c++;
    }
  }
  if (c < 16 || sm <= 0) return { ratio: 0, edges: c };
  const varL = Math.max(0, s2 / c - 20 * sigmaNoise * sigmaNoise);
  return { ratio: Math.sqrt(varL) / (sm / c), edges: c };
}

/** Edge threshold: top 10 % of gradient magnitudes, never below the noise floor. */
export function edgeThreshold(gp: GradientPlanes, sigmaNoise: number): number {
  const q90 = quantile(gp.mag, 0.9);
  // Sobel/8 of pure noise has σ ≈ 0.31·σn per axis; 4σ of that is a safe floor.
  return Math.max(0.012, q90, 4 * 0.31 * sigmaNoise * Math.SQRT2);
}

/**
 * Ratio → 0..100. Calibration (synthetic step edges): Gaussian blur of
 * s = 0.5 px → ≈ 90, 1 px → ≈ 65, 2 px → ≈ 35, 4 px → ≈ 18.
 */
export function sharpnessScore(ratio: number): number {
  return Math.round(100 * clamp01(1 - Math.exp(-ratio / SHARP_R0)));
}
export const SHARP_R0 = 0.95;
export const BLURRY_BELOW = 35;
