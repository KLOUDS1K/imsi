/**
 * Auto straighten (crop.angle) and Upright (transform.vertical / horizontal /
 * rotate) from detected straight lines. DOM-free.
 *
 * Sign conventions (ARCHITECTURE.md): positive angle/rotate = content turns
 * clockwise on screen. transform.vertical = v uses k = 0.4·v/100; the frame
 * is warped so the TOP edge width scales by (1 + k) and the bottom by (1 − k).
 * In half-size coordinates (x, y ∈ [−1, 1], y down) the forward warp is
 *   X = (1 − k²)·x / (1 + k·y),  Y = (y + k) / (1 + k·y)
 * so a source line  x = a·(1 + k·y)  (converging towards the top for k > 0)
 * becomes the vertical X = (1 − k²)·a. Fitting every near-vertical line as
 * x = a + b·y therefore gives b = k·a: k is the slope of b against a.
 * Horizontal: Y = (1 − k²)·y / (1 − k·x) straightens y = a·(1 − k·x), i.e.
 * b = −k·a for lines y = a + b·x.
 *
 * These estimates assume the buffer is the oriented frame (crop.orientation
 * 0, no flips) — callers analysing a rotated photo should pass the oriented
 * proxy.
 */
import type { PixelBuffer } from '@/editor/types';
import { buildLumaPlane } from './buffer';
import { detectLines, levelingRotation, type LineSegment } from './lines';
import { clamp01, clampTo, round2 } from './stats';

const WORK_SIZE = 768;
const KEYSTONE_PER_UNIT = 0.4 / 100;

interface WeightedAngle {
  angle: number;
  weight: number;
}

/** Kernel-density mode of the angles, refined by a local weighted mean. */
function angleMode(items: WeightedAngle[], range: number): { angle: number; support: number; total: number } {
  let total = 0;
  for (const it of items) total += it.weight;
  if (!items.length || total <= 0) return { angle: 0, support: 0, total: 0 };
  const step = 0.05;
  const n = Math.round((2 * range) / step) + 1;
  const dens = new Float64Array(n);
  const sig = 0.35;
  for (const it of items) {
    const c = (it.angle + range) / step;
    const r = Math.ceil((3 * sig) / step);
    for (let k = Math.max(0, Math.floor(c - r)); k <= Math.min(n - 1, Math.ceil(c + r)); k++) {
      const d = (k - c) * step;
      dens[k] += it.weight * Math.exp((-d * d) / (2 * sig * sig));
    }
  }
  let best = 0;
  for (let k = 1; k < n; k++) if (dens[k] > dens[best]) best = k;
  const peak = -range + best * step;
  let sw = 0;
  let sa = 0;
  for (const it of items) {
    if (Math.abs(it.angle - peak) > 0.7) continue;
    sw += it.weight;
    sa += it.weight * it.angle;
  }
  return { angle: sw > 0 ? sa / sw : peak, support: sw, total };
}

/** Weights: long lines dominate; long horizontals are horizon candidates; off-centre verticals suffer from perspective. */
function lineWeights(segs: LineSegment[], w: number, h: number, verticalWeight = 1): WeightedAngle[] {
  const out: WeightedAngle[] = [];
  for (const s of segs) {
    let wt = s.length * Math.min(1, 0.3 + s.strength * 6);
    if (s.family === 'h') {
      if (s.length > 0.35 * w) wt *= 2;
    } else {
      const mid = Math.abs((s.x0 + s.x1) / 2 - w / 2) / (w / 2);
      wt *= (1 - 0.8 * clamp01(mid)) * verticalWeight;
    }
    out.push({ angle: levelingRotation(s), weight: wt });
  }
  return out;
}

export function detectLevelAngle(px: PixelBuffer): { angle: number; confidence: number } {
  const plane = buildLumaPlane(px, WORK_SIZE);
  const segs = detectLines(plane, { maxTilt: 20, minLength: 0.08 });
  return levelFromSegments(segs, plane.width, plane.height);
}

export function levelFromSegments(segs: LineSegment[], w: number, h: number): { angle: number; confidence: number } {
  const items = lineWeights(segs, w, h).filter((it) => Math.abs(it.angle) <= 20);
  if (!items.length) return { angle: 0, confidence: 0 };
  const m = angleMode(items, 20);
  const agreement = m.support / m.total;
  // Enough line evidence ≈ a line as long as the image width.
  const evidence = clamp01(m.support / (0.9 * w));
  const confidence = clamp01(agreement * (0.35 + 0.65 * evidence));
  const angle = Math.abs(m.angle) < 0.03 ? 0 : round2(clampTo(m.angle, -20, 20));
  return { angle, confidence: round2(confidence) };
}

/* ------------------------------------------------------------------ */
/* Perspective                                                         */
/* ------------------------------------------------------------------ */

interface LineFit {
  /** slope of b vs a (the keystone k) */
  k: number;
  /** intercept (a common tilt) */
  c: number;
  /** effective number of lines with spread in a */
  support: number;
  residual: number;
}

/**
 * Robust weighted least squares of b = k·a + c over lines (a, b, weight),
 * with a small ridge on k so a poorly spread set of lines (all on one side)
 * falls back to "no keystone".
 */
function fitKeystone(lines: { a: number; b: number; w: number }[]): LineFit {
  if (lines.length < 2) return { k: 0, c: 0, support: 0, residual: 1 };
  let k = 0;
  let c = 0;
  const wts = lines.map((l) => l.w);
  let swTotal = 0;
  for (const l of lines) swTotal += l.w;
  const ridge = 0.02 * swTotal;
  for (let iter = 0; iter < 4; iter++) {
    let sw = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sab = 0;
    lines.forEach((l, i) => {
      const w = wts[i];
      sw += w;
      sa += w * l.a;
      sb += w * l.b;
      saa += w * l.a * l.a;
      sab += w * l.a * l.b;
    });
    // [saa + ridge, sa; sa, sw] [k; c] = [sab; sb]
    const det = (saa + ridge) * sw - sa * sa;
    if (Math.abs(det) < 1e-12) break;
    k = (sab * sw - sa * sb) / det;
    c = ((saa + ridge) * sb - sa * sab) / det;
    // Cauchy re-weighting: lines that disagree (real diagonals, curved edges) fade out.
    lines.forEach((l, i) => {
      const r = l.b - k * l.a - c;
      wts[i] = l.w / (1 + (r / 0.03) ** 2);
    });
  }
  let sw = 0;
  let spread = 0;
  let res = 0;
  let mean = 0;
  lines.forEach((l, i) => {
    sw += wts[i];
    mean += wts[i] * l.a;
  });
  mean /= sw || 1;
  lines.forEach((l, i) => {
    spread += wts[i] * (l.a - mean) ** 2;
    res += wts[i] * (l.b - k * l.a - c) ** 2;
  });
  return { k, c, support: sw > 0 ? Math.sqrt(spread / sw) * sw : 0, residual: sw > 0 ? Math.sqrt(res / sw) : 1 };
}

/** Forward keystone (vertical then horizontal) in half-size coordinates. */
function keystone(x: number, y: number, kv: number, kh: number): [number, number] {
  let X = ((1 - kv * kv) * x) / (1 + kv * y);
  let Y = (y + kv) / (1 + kv * y);
  const x2 = (X - kh) / (1 - kh * X);
  const y2 = ((1 - kh * kh) * Y) / (1 - kh * X);
  X = x2;
  Y = y2;
  return [X, Y];
}

export function detectPerspective(
  px: PixelBuffer,
  mode: 'auto' | 'vertical' | 'full',
): { vertical: number; horizontal: number; rotate: number; confidence: number } {
  const plane = buildLumaPlane(px, WORK_SIZE);
  const segs = detectLines(plane, { maxTilt: 30, minLength: 0.07, maxLines: 60 });
  return perspectiveFromSegments(segs, plane.width, plane.height, mode);
}

export function perspectiveFromSegments(
  segs: LineSegment[],
  w: number,
  h: number,
  mode: 'auto' | 'vertical' | 'full',
): { vertical: number; horizontal: number; rotate: number; confidence: number } {
  const hw = w / 2;
  const hh = h / 2;
  const toHalf = (x: number, y: number): [number, number] => [(x - hw) / hw, (y - hh) / hh];
  const verts = segs.filter((s) => s.family === 'v');
  const hors = segs.filter((s) => s.family === 'h');

  // Vertical keystone from near-vertical lines: x = a + b·y (half coords).
  const vLines = verts.map((s) => {
    const [x0, y0] = toHalf(s.x0, s.y0);
    const [x1, y1] = toHalf(s.x1, s.y1);
    const b = (x1 - x0) / (y1 - y0 || 1e-6);
    return { a: x0 - b * y0, b, w: s.length };
  });
  const vf = fitKeystone(vLines);
  // Need lines at different horizontal positions to separate keystone from tilt.
  const vConf = clamp01(vf.support / (0.25 * h)) * Math.exp(-vf.residual / 0.05);
  let kv = vLines.length >= 2 ? vf.k * clamp01(vConf * 2) : 0;

  // Horizontal keystone in the space after the vertical warp: y = a + b·x.
  let kh = 0;
  let hConf = 0;
  if (mode !== 'vertical') {
    const hLines = hors.map((s) => {
      const [x0, y0] = keystone(...toHalf(s.x0, s.y0), kv, 0);
      const [x1, y1] = keystone(...toHalf(s.x1, s.y1), kv, 0);
      const b = (y1 - y0) / (x1 - x0 || 1e-6);
      return { a: y0 - b * x0, b, w: s.length };
    });
    const hf = fitKeystone(hLines);
    hConf = clamp01(hf.support / (0.25 * w)) * Math.exp(-hf.residual / 0.05);
    kh = hLines.length >= 2 ? -hf.k * clamp01(hConf * 2) : 0;
  }

  // Strength per mode ('auto' is deliberately partial, like a "balanced" upright).
  const kMax = 100 * KEYSTONE_PER_UNIT;
  if (mode === 'auto') {
    kv = clampTo(kv * 0.8, -0.6 * kMax, 0.6 * kMax);
    kh = hConf > 0.35 ? clampTo(kh * 0.5, -0.3 * kMax, 0.3 * kMax) : 0;
  } else {
    kv = clampTo(kv, -kMax, kMax);
    kh = mode === 'full' ? clampTo(kh, -kMax, kMax) : 0;
  }

  // Residual rotation after the keystone (rotate is applied after it).
  const warped: LineSegment[] = segs.map((s) => {
    const [a0, b0] = keystone(...toHalf(s.x0, s.y0), kv, kh);
    const [a1, b1] = keystone(...toHalf(s.x1, s.y1), kv, kh);
    return { ...s, x0: a0 * hw + hw, y0: b0 * hh + hh, x1: a1 * hw + hw, y1: b1 * hh + hh };
  });
  // After the warp verticals are parallel, so all of them are equally informative.
  const items = warped
    .map((s) => ({ angle: levelingRotation(s), weight: s.length * (s.family === 'h' && s.length > 0.35 * w ? 2 : 1) }))
    .filter((it) => Math.abs(it.angle) <= 10);
  const m = angleMode(items, 10);
  const rotConf = m.total > 0 ? m.support / m.total : 0;
  const rotate = rotConf > 0.2 && Math.abs(m.angle) >= 0.03 ? round2(clampTo(m.angle, -10, 10)) : 0;

  const vertical = Math.round(kv / KEYSTONE_PER_UNIT);
  const horizontal = Math.round(kh / KEYSTONE_PER_UNIT);
  const confParts = [vConf];
  if (mode !== 'vertical') confParts.push(hConf * 0.8);
  const confidence = clamp01(Math.max(...confParts) * 0.7 + rotConf * 0.3 * clamp01(items.length / 4));
  return { vertical, horizontal, rotate, confidence: round2(confidence) };
}
