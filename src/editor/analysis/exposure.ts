/**
 * Exposure statistics and the Lightroom-like "Auto" tone solver.
 *
 * Luminance values reported in ImageAnalysis.exposure (meanLum, medianLum,
 * p01, p99) are LINEAR relative luminance 0..1; 18 % grey = 0.18.
 *
 * The solver only uses quantities that are also present in ImageAnalysis, so
 * `autoTone(px)` and `generateAutoEdit(analyzeImage(px))` produce identical
 * basic-tone values (the auto edit may run in another thread on a cloned
 * analysis object).
 *
 * Whites/blacks/contrast are modelled with the same curve shapes the develop
 * shader uses (engine/color/tone.ts: whitesCurve / blacksCurve on perceptual
 * luminance). The constants are mirrored here instead of imported so this
 * module stays tiny inside the analysis worker.
 */
import type { ImageAnalysis } from '@/editor/types';
import { linearToSrgb, smoothstep } from '@/editor/color/math';
import type { WorkImage } from './buffer';
import { clamp01, clampTo, histQuantile, round2 } from './stats';

const BINS = 1024;
const MID_GREY = 0.18;

export interface ExposureStats {
  meanLum: number;
  medianLum: number;
  p005: number;
  p01: number;
  p99: number;
  p995: number;
  evOffset: number;
  verdict: 'under' | 'ok' | 'over';
  /** Dynamic range between p01 and p99, in stops. */
  stops: number;
  /** RMS contrast: standard deviation of the perceptual (sRGB-encoded) luminance. */
  rmsContrast: number;
  clipHigh: number;
  clipLow: number;
  /** Histogram of perceptual luminance (1024 bins) for further use. */
  hist: Float64Array;
}

const toLinear = (e: number) => (e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4));

export function exposureStats(img: WorkImage): ExposureStats {
  const { luma, lum } = img;
  const n = luma.length;
  const hist = new Float64Array(BINS);
  let sum = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const e = luma[i];
    hist[Math.min(BINS - 1, (e * BINS) | 0)]++;
    sum += lum[i];
    s1 += e;
    s2 += e * e;
  }
  const q = (p: number) => toLinear(histQuantile(hist, n, p));
  const meanLum = n ? sum / n : 0;
  const medianLum = q(0.5);
  const p005 = q(0.005);
  const p01 = q(0.01);
  const p99 = q(0.99);
  const p995 = q(0.995);
  const meanE = n ? s1 / n : 0;
  const rmsContrast = Math.sqrt(Math.max(0, n ? s2 / n - meanE * meanE : 0));
  const evOffset = clampTo(Math.log2(MID_GREY / Math.max(medianLum, 1 / 4096)), -5, 5);
  const e99 = linearToSrgb(p99);
  let verdict: ExposureStats['verdict'] = 'ok';
  if (evOffset > 0.9 && e99 < 0.9) verdict = 'under';
  else if (evOffset < -0.9 || img.clipHigh > 0.06) verdict = 'over';
  const stops = Math.log2(Math.max(p99, 1 / 4096) / Math.max(p01, 1 / 4096));
  return {
    meanLum,
    medianLum,
    p005,
    p01,
    p99,
    p995,
    evOffset,
    verdict,
    stops,
    rmsContrast,
    clipHigh: img.clipHigh,
    clipLow: img.clipLow,
    hist,
  };
}

/* ------------------------------------------------------------------ */
/* Tone solver                                                         */
/* ------------------------------------------------------------------ */

/** Everything the solver needs — all available from ImageAnalysis. */
export interface ToneInputs {
  meanLum: number;
  medianLum: number;
  p01: number;
  p99: number;
  clippedHighlights: number;
  clippedShadows: number;
  /** RMS contrast of perceptual luminance. */
  contrast: number;
  colorfulness: number;
  meanSaturation: number;
}

export interface ToneResult {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
}

export function toneInputsFromAnalysis(a: ImageAnalysis): ToneInputs {
  return {
    meanLum: a.exposure.meanLum,
    medianLum: a.exposure.medianLum,
    p01: a.exposure.p01,
    p99: a.exposure.p99,
    clippedHighlights: a.dynamicRange.clippedHighlights,
    clippedShadows: a.dynamicRange.clippedShadows,
    contrast: a.dynamicRange.contrast,
    colorfulness: a.color.colorfulness,
    meanSaturation: a.color.meanSaturation,
  };
}

// Mirrors of engine/color/constants.ts (whites / blacks curve shapes).
const WHITES_GAIN = 0.22;
const WHITES_LO = 0.2;
const WHITES_HI = 1.0;
const BLACKS_LIFT = 0.07;
const BLACKS_HI = 0.55;
const BLACKS_KNEE = 0.03;
const HIGHLIGHTS_EV = 0.55;

function whitesCurve(p: number, w: number): number {
  return p * (1 + w * WHITES_GAIN * smoothstep(WHITES_LO, WHITES_HI, p));
}

function blacksCurve(p: number, b: number): number {
  if (b === 0) return p;
  const shift = BLACKS_LIFT * (1 - smoothstep(0, BLACKS_HI, p));
  if (b > 0) return p + b * shift;
  const x = p + b * shift;
  const k = BLACKS_KNEE * -b;
  return x >= k ? x : k * Math.exp((x - k) / k);
}

/** Bisection for a monotone-increasing f(s) over s ∈ [-1, 1]. */
function solveMonotone(f: (s: number) => number, target: number): number {
  let lo = -1;
  let hi = 1;
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Target perceptual levels for p99 / p01 after auto tone ("just inside clipping" for p99.5 / p0.5). */
const WHITE_TARGET = 0.94;
const BLACK_TARGET = 0.035;

/** Auto exposure in EV from luminance statistics. */
export function solveExposure(t: ToneInputs): number {
  const median = Math.max(t.medianLum, 1 / 4096);
  const mean = Math.max(t.meanLum, 1 / 4096);
  // Geometric blend of median and mean: the median alone over-reacts to
  // large uniform areas, the mean alone to a few bright highlights.
  const key = Math.exp(0.65 * Math.log(median) + 0.35 * Math.log(mean));
  let ev = 0.85 * Math.log2(MID_GREY / key);
  const p99 = Math.max(t.p99, 1 / 4096);
  if (ev > 0) {
    // Do not push the brightest 1 % far past white (the highlights slider can
    // recover a little, clipping cannot be undone).
    ev = Math.min(ev, Math.max(0, Math.log2(1 / p99) + 0.3));
  } else if (t.clippedHighlights < 0.02) {
    // High-key scenes (snow, white studio): do not drag the brightest tones
    // down to grey just because the median is high.
    ev = Math.max(ev, Math.min(0, Math.log2(0.72 / p99)));
  }
  return round2(clampTo(ev, -3, 3.5));
}

export function solveTone(t: ToneInputs): ToneResult {
  const exposure = solveExposure(t);
  const gain = Math.pow(2, exposure);
  const p99 = t.p99 * gain;
  const p01 = t.p01 * gain;
  const med = t.medianLum * gain;
  const e99 = linearToSrgb(Math.min(p99, 4));
  const e01 = linearToSrgb(p01);
  const e50 = linearToSrgb(med);
  // Clipping after the exposure change (a rough upper bound when pushing up).
  const clipH = exposure > 0 && p99 > 1 ? Math.max(t.clippedHighlights, 0.01) : t.clippedHighlights;

  // Highlights: recover bright tones, stronger when they clip.
  let highlights = 0;
  if (e99 > 0.72) highlights = -(10 + 45 * clamp01((e99 - 0.72) / 0.28) + 400 * clipH);
  highlights = clampTo(highlights, -90, 0);

  // Shadows: open up a heavy dark mass (dark median or crushed low end).
  let shadows = 55 * clamp01((0.42 - e50) / 0.3) + 20 * clamp01((0.1 - e01) / 0.1);
  if (exposure > 1) shadows *= 0.7; // exposure already lifted them
  shadows = clampTo(shadows, 0, 70);

  // Whites: bring p99 (after the highlights slider) just below white.
  const hlStops = (HIGHLIGHTS_EV * 0.8 * highlights) / 100;
  const e99h = linearToSrgb(Math.min(p99 * Math.pow(2, hlStops), 4));
  let whites = solveMonotone((w) => whitesCurve(Math.min(e99h, 1.2), w), WHITE_TARGET);
  if (clipH > 0.005) whites = Math.min(whites, 0);
  whites = clampTo(whites * 100, -60, 60);

  // Blacks: bring p01 just above black.
  let blacks = solveMonotone((b) => blacksCurve(e01, b), BLACK_TARGET);
  if (t.clippedShadows > 0.03 && e01 < 0.02) blacks = Math.max(blacks, 0);
  blacks = clampTo(blacks * 100, -60, 40);

  // Contrast from the spread of perceptual luminance (≈ 0.2 is "normal").
  let contrast = clampTo((0.2 - t.contrast) * 220, -20, 30);
  // Whites up / blacks down already add global contrast.
  contrast -= Math.max(0, whites - blacks) * 0.08;
  contrast = clampTo(contrast, -20, 30);

  // Gentle colour: more vibrance for muted images, none for monochrome ones.
  let vibrance = 0;
  let saturation = 0;
  if (t.meanSaturation > 0.04) {
    vibrance = clampTo(32 - t.colorfulness * 0.3, 0, 28);
    saturation = clampTo(6 - t.colorfulness * 0.08, -6, 5);
  }
  const r = (v: number) => Math.round(v);
  return {
    exposure,
    contrast: r(contrast),
    highlights: r(highlights),
    shadows: r(shadows),
    whites: r(whites),
    blacks: r(blacks),
    vibrance: r(vibrance),
    saturation: r(saturation),
  };
}
