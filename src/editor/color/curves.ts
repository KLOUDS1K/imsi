/**
 * Tone-curve math shared by the engine (LUT upload), the curve editor (drawing)
 * and style learning (curve fitting).
 *
 * Order (Lightroom): parametric → point RGB → per-channel point curve.
 */
import type { CurvePoint, ParametricCurve, ToneCurveParams } from '../types';
import { clamp } from './math';

/** Sort, clamp and de-duplicate points; guarantees ≥ 2 points. */
export function normalizeCurve(points: CurvePoint[]): CurvePoint[] {
  const pts = points
    .map((p) => ({ x: clamp(p.x), y: clamp(p.y) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x - arr[i - 1].x > 1e-4);
  if (pts.length === 0) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  if (pts.length === 1) return pts[0].x < 0.5 ? [pts[0], { x: 1, y: 1 }] : [{ x: 0, y: 0 }, pts[0]];
  return pts;
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.x - p.y) < 1e-4);
}

export function isIdentityParametric(p: ParametricCurve): boolean {
  return p.highlights === 0 && p.lights === 0 && p.darks === 0 && p.shadows === 0;
}

export function isIdentityToneCurve(tc: ToneCurveParams): boolean {
  return (
    isIdentityParametric(tc.parametric) &&
    isIdentityCurve(tc.rgb) &&
    isIdentityCurve(tc.red) &&
    isIdentityCurve(tc.green) &&
    isIdentityCurve(tc.blue)
  );
}

/**
 * Build an evaluator for a monotone cubic Hermite spline (Fritsch–Carlson)
 * through the points. Outside the end points the curve is flat.
 */
export function createCurveEvaluator(points: CurvePoint[]): (x: number) => number {
  const pts = normalizeCurve(points);
  const n = pts.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  if (n === 2) {
    const [x0, x1] = xs;
    const [y0, y1] = ys;
    return (x) => (x <= x0 ? y0 : x >= x1 ? y1 : clamp(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)));
  }
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else i = mid;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return clamp(y);
  };
}

/**
 * Parametric curve: four region sliders bend the diagonal. Each region gets a
 * smooth bump spanning its neighbours; the result is forced monotone.
 * Returns an evaluator over 0..1.
 */
export function createParametricEvaluator(p: ParametricCurve): (x: number) => number {
  if (isIdentityParametric(p)) return (x) => x;
  const s1 = clamp(p.split1 / 100, 0.05, 0.9);
  const s2 = clamp(p.split2 / 100, s1 + 0.02, 0.95);
  const s3 = clamp(p.split3 / 100, s2 + 0.02, 0.98);
  // region centres and half-widths
  const regions: [number, number, number][] = [
    [s1 / 2, s1 / 2 + 0.1, p.shadows],
    [(s1 + s2) / 2, (s2 - s1) / 2 + 0.12, p.darks],
    [(s2 + s3) / 2, (s3 - s2) / 2 + 0.12, p.lights],
    [(s3 + 1) / 2, (1 - s3) / 2 + 0.1, p.highlights],
  ];
  const N = 1024;
  const table = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    let y = x;
    for (const [c, w, amt] of regions) {
      if (!amt) continue;
      const u = (x - c) / w;
      if (Math.abs(u) >= 1) continue;
      const bump = Math.cos((u * Math.PI) / 2) ** 2;
      // Keep end points pinned; scale shift so ±100 ≈ ±0.25 output.
      y += (amt / 100) * 0.25 * bump * Math.min(1, x * 8, (1 - x) * 8);
    }
    table[i] = clamp(y);
  }
  for (let i = 1; i <= N; i++) if (table[i] < table[i - 1]) table[i] = table[i - 1];
  return (x: number) => {
    const f = clamp(x) * N;
    const i = Math.floor(f);
    if (i >= N) return table[N];
    return table[i] + (table[i + 1] - table[i]) * (f - i);
  };
}

/**
 * Combined curve LUT for the GPU: RGBA float, `size` texels.
 * R = red(rgb(param(x))), G = green(...), B = blue(...), A = rgb(param(x)).
 * The shader applies it to display-referred (sRGB-encoded) values.
 */
export function buildCurveLut(tc: ToneCurveParams, size = 1024): Float32Array {
  const param = createParametricEvaluator(tc.parametric);
  const master = createCurveEvaluator(tc.rgb);
  const r = createCurveEvaluator(tc.red);
  const g = createCurveEvaluator(tc.green);
  const b = createCurveEvaluator(tc.blue);
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    const m = master(param(x));
    out[i * 4] = r(m);
    out[i * 4 + 1] = g(m);
    out[i * 4 + 2] = b(m);
    out[i * 4 + 3] = m;
  }
  return out;
}

/** Sample a curve at `n` evenly spaced points (for drawing). */
export function sampleCurve(points: CurvePoint[], n = 256): Float32Array {
  const f = createCurveEvaluator(points);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i / (n - 1));
  return out;
}
