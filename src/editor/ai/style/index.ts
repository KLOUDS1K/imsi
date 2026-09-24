/**
 * KLOUD Style — personal editing style learning (contracts.StyleModule).
 *
 * Features: a fixed 32-value description of the ORIGINAL image.
 * Model: per-parameter ridge regression on standardized features, falling
 * back to the weighted mean ("baseline") when there are fewer than 3 pairs.
 * Pair estimation: exposure, white balance, saturation and a 5-point tone
 * curve fitted from a pixel-aligned original/edited pair.
 */
import type { StyleModule } from '../../contracts';
import { clamp, luminance, rgbToHsv, SRGB8_TO_LINEAR, tempTintFromNeutral } from '../../color/math';
import { createDefaultParams, PARAM_SPECS } from '../../defaults';
import type { EditParams, PartialParams, PhotoMeta, PixelBuffer, StyleModel, StylePair } from '../../types';
import { getPath, setPath } from '../../state';

/* ----------------------------- sampling ----------------------------- */

interface Samples {
  w: number;
  h: number;
  /** sRGB-encoded 0..1 */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

function sample(px: PixelBuffer, max = 256): Samples {
  const s = Math.min(1, max / Math.max(px.width, px.height));
  const w = Math.max(1, Math.round(px.width * s));
  const h = Math.max(1, Math.round(px.height * s));
  const out: Samples = { w, h, r: new Float32Array(w * h), g: new Float32Array(w * h), b: new Float32Array(w * h) };
  const d = px.data;
  const scale = d instanceof Uint16Array ? 65535 : d instanceof Float32Array ? 1 : 255;
  const lin = px.transfer === 'linear';
  const enc = (v: number) => (lin ? (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055) : v);
  for (let j = 0; j < h; j++) {
    const sy = Math.min(px.height - 1, Math.floor((j + 0.5) / s));
    for (let i = 0; i < w; i++) {
      const sx = Math.min(px.width - 1, Math.floor((i + 0.5) / s));
      const o = (sy * px.width + sx) * 4;
      const k = j * w + i;
      out.r[k] = clamp(enc(d[o] / scale));
      out.g[k] = clamp(enc(d[o + 1] / scale));
      out.b[k] = clamp(enc(d[o + 2] / scale));
    }
  }
  return out;
}

const lin8 = (v: number) => SRGB8_TO_LINEAR[Math.round(clamp(v) * 255)];
const lumOf = (s: Samples, k: number) => luminance(lin8(s.r[k]), lin8(s.g[k]), lin8(s.b[k]));

function percentile(values: Float32Array, q: number): number {
  const a = Float32Array.from(values).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

/* ----------------------------- features ----------------------------- */

/**
 * 0-6 luminance percentiles p1,p5,p25,p50,p75,p95,p99 (linear) · 7 log2 mean
 * luminance · 8 RMS contrast · 9-11 mean R,G,B (encoded) · 12 mean saturation ·
 * 13 saturation std · 14-25 saturation-weighted 12-bin hue histogram ·
 * 26 temperature cast /100 · 27 tint cast /100 · 28 log2(ISO/100) ·
 * 29 log2(shutter·60) · 30 log2(focal/35) · 31 clipped highlight fraction
 */
export function extractFeatures(px: PixelBuffer, meta?: PhotoMeta): number[] {
  const s = sample(px, 192);
  const n = s.w * s.h;
  const L = new Float32Array(n);
  let sumL = 0;
  let sumLog = 0;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  let sSum = 0;
  let sSq = 0;
  let clip = 0;
  const hue = new Array(12).fill(0);
  for (let k = 0; k < n; k++) {
    const l = lumOf(s, k);
    L[k] = l;
    sumL += l;
    sumLog += Math.log2(l + 1e-4);
    mr += s.r[k];
    mg += s.g[k];
    mb += s.b[k];
    const [hh, sat] = rgbToHsv(s.r[k], s.g[k], s.b[k]);
    sSum += sat;
    sSq += sat * sat;
    hue[Math.floor(hh / 30) % 12] += sat;
    if (Math.max(s.r[k], s.g[k], s.b[k]) > 0.99) clip++;
  }
  const meanL = sumL / n;
  let varL = 0;
  for (let k = 0; k < n; k++) varL += (L[k] - meanL) ** 2;
  const hueTot = hue.reduce((a, b) => a + b, 0) || 1;
  const cast = tempTintFromNeutral([lin8(mr / n), lin8(mg / n), lin8(mb / n)]);
  const satMean = sSum / n;
  return [
    ...[0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((q) => percentile(L, q)),
    sumLog / n,
    Math.sqrt(varL / n),
    mr / n,
    mg / n,
    mb / n,
    satMean,
    Math.sqrt(Math.max(0, sSq / n - satMean * satMean)),
    ...hue.map((v) => v / hueTot),
    cast.temperature / 100,
    cast.tint / 100,
    meta?.iso ? Math.log2(meta.iso / 100) : 0,
    meta?.shutter ? Math.log2(meta.shutter * 60) : 0,
    meta?.focalLength ? Math.log2(meta.focalLength / 35) : 0,
    clip / n,
  ];
}

/* --------------------------- pair estimation ------------------------ */

export function estimateParamsFromPair(original: PixelBuffer, edited: PixelBuffer): PartialParams {
  const a = sample(original, 256);
  const b = sample(edited, 256);
  // Align by sampling the edited image on the original's grid (same framing assumed).
  const n = a.w * a.h;
  const la = new Float32Array(n);
  const lb = new Float32Array(n);
  let satA = 0;
  let satB = 0;
  const neutral = [0, 0, 0, 0, 0, 0];
  let nn = 0;
  for (let j = 0; j < a.h; j++) {
    const jb = Math.min(b.h - 1, Math.floor(((j + 0.5) / a.h) * b.h));
    for (let i = 0; i < a.w; i++) {
      const ib = Math.min(b.w - 1, Math.floor(((i + 0.5) / a.w) * b.w));
      const k = j * a.w + i;
      const kb = jb * b.w + ib;
      la[k] = lumOf(a, k);
      lb[k] = lumOf(b, kb);
      const sa = rgbToHsv(a.r[k], a.g[k], a.b[k])[1];
      const sb = rgbToHsv(b.r[kb], b.g[kb], b.b[kb])[1];
      satA += sa;
      satB += sb;
      // Near-neutral mid-tones in the ORIGINAL drive the white-balance estimate.
      if (sa < 0.12 && la[k] > 0.05 && la[k] < 0.7) {
        neutral[0] += lin8(a.r[k]);
        neutral[1] += lin8(a.g[k]);
        neutral[2] += lin8(a.b[k]);
        neutral[3] += lin8(b.r[kb]);
        neutral[4] += lin8(b.g[kb]);
        neutral[5] += lin8(b.b[kb]);
        nn++;
      }
    }
  }
  const medA = percentile(la, 0.5);
  const medB = percentile(lb, 0.5);
  const exposure = clamp(Math.log2((medB + 1e-4) / (medA + 1e-4)), -3, 3);
  let temperature = 0;
  let tint = 0;
  if (nn > n * 0.01) {
    const ta = tempTintFromNeutral([neutral[0], neutral[1], neutral[2]]);
    const tb = tempTintFromNeutral([neutral[3], neutral[4], neutral[5]]);
    // The edit moved the neutral's cast from ta to tb: the applied WB is the difference.
    temperature = clamp(ta.temperature - tb.temperature, -100, 100);
    tint = clamp(ta.tint - tb.tint, -100, 100);
  }
  const saturation = clamp((satB / Math.max(satA, 1e-3) - 1) * 100, -100, 100);
  // Tone curve: residual luminance mapping after exposure, sampled at 5 points (display-referred).
  const gain = Math.pow(2, exposure);
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9];
  const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
  const pairs: [number, number][] = [];
  for (let k = 0; k < n; k++) pairs.push([enc(Math.min(1, la[k] * gain)), enc(Math.min(1, lb[k]))]);
  pairs.sort((p, q) => p[0] - q[0]);
  const rgb = [{ x: 0, y: 0 }];
  for (const x of xs) {
    const lo = pairs.findIndex((p) => p[0] >= x - 0.05);
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(0, lo); i < pairs.length && pairs[i][0] <= x + 0.05; i++) {
      sum += pairs[i][1];
      cnt++;
    }
    rgb.push({ x, y: cnt > 3 ? clamp(sum / cnt) : x });
  }
  rgb.push({ x: 1, y: 1 });
  for (let i = 1; i < rgb.length; i++) rgb[i].y = Math.max(rgb[i].y, rgb[i - 1].y);
  return {
    basic: { exposure: Math.round(exposure * 100) / 100 },
    whiteBalance: { mode: 'custom', temperature: Math.round(temperature), tint: Math.round(tint) },
    color: { saturation: Math.round(saturation) },
    toneCurve: { rgb },
  };
}

/* ------------------------------ model ------------------------------- */

const CURVE_X = [0.1, 0.25, 0.5, 0.75, 0.9];

function pathsFor(learn: StyleModel['learn']): string[] {
  const p: string[] = [];
  if (learn.exposure) p.push('basic.exposure', 'basic.contrast', 'basic.highlights', 'basic.shadows', 'basic.whites', 'basic.blacks');
  if (learn.color) p.push('whiteBalance.temperature', 'whiteBalance.tint', 'color.vibrance', 'color.saturation');
  if (learn.toneCurve) for (const x of CURVE_X) p.push(`curve.${x}`);
  if (learn.hsl) for (const c of ['orange', 'blue', 'green', 'red']) p.push(`hsl.${c}.hue`, `hsl.${c}.saturation`, `hsl.${c}.luminance`);
  return p;
}

function curveAt(points: { x: number; y: number }[] | undefined, x: number): number {
  if (!points || points.length < 2) return x;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (x >= a.x && x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
  }
  return x;
}

export function paramsToVector(params: PartialParams, paths: string[]): number[] {
  const defaults = createDefaultParams();
  return paths.map((p) => {
    if (p.startsWith('curve.')) {
      const x = Number(p.slice(6));
      return curveAt(params.toneCurve?.rgb as { x: number; y: number }[] | undefined, x) - x;
    }
    const v = getPath(params, p);
    return typeof v === 'number' ? v : Number(getPath(defaults, p) ?? 0);
  });
}

export function vectorToParams(vec: number[], paths: string[]): PartialParams {
  const out = {} as EditParams;
  const curve: { x: number; y: number }[] = [];
  paths.forEach((p, i) => {
    const v = vec[i] ?? 0;
    if (p.startsWith('curve.')) {
      const x = Number(p.slice(6));
      curve.push({ x, y: clamp(x + v) });
      return;
    }
    const spec = PARAM_SPECS[p];
    const val = spec ? clamp(v, spec.min, spec.max) : clamp(v, -100, 100);
    setPath(out, p, p === 'basic.exposure' ? Math.round(val * 100) / 100 : Math.round(val));
  });
  if (curve.length) {
    curve.sort((a, b) => a.x - b.x);
    for (let i = 1; i < curve.length; i++) curve[i].y = Math.max(curve[i].y, curve[i - 1].y);
    setPath(out, 'toneCurve', { rgb: [{ x: 0, y: 0 }, ...curve, { x: 1, y: 1 }] });
  }
  return out as PartialParams;
}

export function createStyleModel(name: string, learn: Partial<StyleModel['learn']> = {}): StyleModel {
  const l = { exposure: true, color: true, toneCurve: true, hsl: true, masks: false, ...learn };
  const paramPaths = pathsFor(l);
  const now = Date.now();
  return {
    id: `style-${now.toString(36)}`,
    name,
    builtin: false,
    created: now,
    trained: 0,
    pairCount: 0,
    paramPaths,
    weights: [],
    featureMean: [],
    featureStd: [],
    baseline: paramPaths.map(() => 0),
    learn: l,
  };
}

/** Solve (XᵀWX + λI) β = XᵀWy by Gaussian elimination. */
function ridge(X: number[][], y: number[], w: number[], lambda: number): number[] {
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d + 1).fill(0));
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < d; i++) {
      A[i][d] += w[r] * X[r][i] * y[r];
      for (let j = 0; j < d; j++) A[i][j] += w[r] * X[r][i] * X[r][j];
    }
  }
  for (let i = 1; i < d; i++) A[i][i] += lambda; // column 0 is the intercept (not penalized)
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c] || 1e-9;
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      for (let k = c; k <= d; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[d] / (A[i][i] || 1e-9));
}

export function trainStyleModel(model: StyleModel, pairs: StylePair[]): StyleModel {
  const usable = pairs.filter((p) => p.features.length > 0);
  const paths = model.paramPaths;
  const Y = usable.map((p) => paramsToVector(p.params, paths));
  const W = usable.map((p) => p.weight || 1);
  const wSum = W.reduce((a, b) => a + b, 0) || 1;
  const baseline = paths.map((_, j) => Y.reduce((s, y, r) => s + y[j] * W[r], 0) / wSum);
  const out: StyleModel = { ...model, baseline, pairCount: usable.length, trained: Date.now(), weights: [], featureMean: [], featureStd: [] };
  if (usable.length < 3) return out;
  const d = usable[0].features.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const p of usable) p.features.forEach((v, i) => (mean[i] += v / usable.length));
  for (const p of usable) p.features.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / usable.length));
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]) || 1;
  const X = usable.map((p) => [1, ...p.features.map((v, i) => (v - mean[i]) / std[i])]);
  // Stronger shrinkage with few pairs keeps predictions close to the baseline.
  const lambda = Math.max(1, 30 / usable.length) * d * 0.5;
  const weights: number[] = [];
  paths.forEach((_, j) => weights.push(...ridge(X, Y.map((y) => y[j]), W, lambda)));
  return { ...out, weights, featureMean: mean, featureStd: std };
}

export function predictParams(model: StyleModel, features: number[], strength = 100): PartialParams {
  const paths = model.paramPaths;
  const d = model.featureMean.length;
  let vec: number[];
  if (model.weights.length === paths.length * (d + 1) && d > 0 && features.length === d) {
    const x = [1, ...features.map((v, i) => (v - model.featureMean[i]) / (model.featureStd[i] || 1))];
    vec = paths.map((_, j) => x.reduce((s, xv, i) => s + xv * model.weights[j * (d + 1) + i], 0));
  } else {
    vec = [...model.baseline];
  }
  // Built-in model: pull exposure toward a pleasant median (feature 3 = p50 luminance).
  if (model.builtin && features.length > 3) {
    const e = paths.indexOf('basic.exposure');
    if (e >= 0) vec[e] += clamp(Math.log2(0.18 / Math.max(features[3], 0.005)) * 0.5, -1.5, 1.5);
  }
  const k = strength / 100;
  const defaults = paramsToVector(createDefaultParams(), paths);
  return vectorToParams(vec.map((v, i) => defaults[i] + (v - defaults[i]) * k), paths);
}

export function learnFromFeedback(
  model: StyleModel,
  features: number[],
  _predicted: PartialParams,
  final: EditParams,
  pairs: StylePair[],
): { model: StyleModel; pair: StylePair } {
  const pair: StylePair = {
    id: `pair-${Date.now().toString(36)}`,
    modelId: model.id,
    name: 'Feedback',
    originalThumb: null,
    editedThumb: null,
    features,
    params: final as PartialParams,
    source: 'feedback',
    weight: 2,
    created: Date.now(),
  };
  return { model: trainStyleModel(model, [...pairs, pair]), pair };
}

/* ---------------------------- KLOUD house style ---------------------------- */

function kloudBaseline(): { paths: string[]; values: number[] } {
  const paths = pathsFor({ exposure: true, color: true, toneCurve: true, hsl: true, masks: false });
  const look: Record<string, number> = {
    'basic.contrast': 8,
    'basic.highlights': -22,
    'basic.shadows': 18,
    'basic.whites': 6,
    'basic.blacks': -6,
    'color.vibrance': 12,
    'color.saturation': -4,
    'curve.0.1': 0.025, // lifted blacks
    'curve.0.25': -0.01,
    'curve.0.75': 0.02,
    'curve.0.9': 0.005,
    'hsl.orange.luminance': 5,
    'hsl.orange.saturation': -4,
    'hsl.blue.saturation': -10,
    'hsl.blue.hue': -4,
    'hsl.green.hue': 8,
    'hsl.green.saturation': -12,
  };
  return { paths, values: paths.map((p) => look[p] ?? 0) };
}

const base = kloudBaseline();
export const KLOUD_STYLE: StyleModel = {
  id: 'kloud.house',
  name: 'KLOUD',
  builtin: true,
  created: 0,
  trained: 0,
  pairCount: 0,
  paramPaths: base.paths,
  weights: [],
  featureMean: [],
  featureStd: [],
  baseline: base.values,
  learn: { exposure: true, color: true, toneCurve: true, hsl: true, masks: false },
};

export const styleModule = {
  KLOUD_STYLE,
  extractFeatures,
  estimateParamsFromPair,
  createStyleModel,
  trainStyleModel,
  predictParams,
  learnFromFeedback,
  paramsToVector,
  vectorToParams,
} satisfies StyleModule;
