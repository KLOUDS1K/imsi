/**
 * lerpParams: interpolate a → b. Used for preset amount (0..200 %), AI/style
 * strength and before/after blends.
 *
 * - numbers: linear, t may extrapolate up to 2, clamped to each field's range
 * - point curves: both resampled on the union of their x knots, y lerped
 * - grading wheels: lerp in the (hue, saturation) vector plane so a hue change
 *   passes through desaturation instead of sweeping the colour wheel
 * - booleans / enums / strings: switch to b at t ≥ 0.5
 * - masks: the mask list comes from b; adjustments/amount of masks present in
 *   both are lerped, masks new in b fade in from neutral adjustments
 * - retouch: from b
 */
import { createDefaultLocalAdjustments, LOCAL_SPECS } from '@/editor/defaults';
import { createCurveEvaluator, normalizeCurve } from '@/editor/color/curves';
import type { CurvePoint, EditParams, GradeWheel, LocalAdjustments, Mask } from '@/editor/types';
import { deepEqual, isPlainObject, joinPath, type PlainObject } from './paths';
import { cloneParams, fixConsistency } from './normalize';
import { clampToSpec, CURVE_PATHS, wrapHue } from './specs';

const WHEEL_PATH_RE = /^colorGrading\.(shadows|midtones|highlights|global)$/;
const DEG = Math.PI / 180;

export function lerpParams(a: EditParams, b: EditParams, t: number): EditParams {
  const tt = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0;
  if (tt === 0) return cloneParams(a);
  if (tt === 1) return cloneParams(b);
  const out = lerpNode(a, b, tt, '') as EditParams;
  out.version = 1;
  return fixConsistency(out);
}

function lerpNode(a: unknown, b: unknown, t: number, path: string): unknown {
  if (path === 'masks') return lerpMasks(a as Mask[], b as Mask[], t);
  if (path === 'retouch') return structuredClone(b);
  if (CURVE_PATHS.has(path)) return lerpCurve(a as CurvePoint[], b as CurvePoint[], t);
  if (WHEEL_PATH_RE.test(path)) return lerpWheel(a as GradeWheel, b as GradeWheel, t);
  if (path === 'crop.orientation') return t >= 0.5 ? b : a;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return a;
    return clampToSpec(path, a + (b - a) * t);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: PlainObject = {};
    for (const k of Object.keys(a)) {
      out[k] = Object.prototype.hasOwnProperty.call(b, k) ? lerpNode(a[k], b[k], t, joinPath(path, k)) : structuredClone(a[k]);
    }
    return out;
  }
  // booleans, enums, strings, null, tuples (customAspect)
  return structuredClone(t >= 0.5 ? b : a);
}

/** Lerp two monotone point curves by resampling both on the union of their knots. */
export function lerpCurve(a: CurvePoint[], b: CurvePoint[], t: number): CurvePoint[] {
  if (deepEqual(a, b)) return a.map((p) => ({ x: p.x, y: p.y }));
  const fa = createCurveEvaluator(a);
  const fb = createCurveEvaluator(b);
  const xs = [...a.map((p) => p.x), ...b.map((p) => p.x)].sort((p, q) => p - q);
  const pts: CurvePoint[] = [];
  for (const x of xs) {
    if (pts.length && x - pts[pts.length - 1].x < 1e-4) continue;
    const ya = fa(x);
    const y = ya + (fb(x) - ya) * t;
    pts.push({ x, y: y < 0 ? 0 : y > 1 ? 1 : y });
  }
  return normalizeCurve(pts);
}

/** Lerp grading wheels in the saturation·(cos h, sin h) plane; luminance linearly. */
export function lerpWheel(a: GradeWheel, b: GradeWheel, t: number): GradeWheel {
  const ax = a.saturation * Math.cos(a.hue * DEG);
  const ay = a.saturation * Math.sin(a.hue * DEG);
  const bx = b.saturation * Math.cos(b.hue * DEG);
  const by = b.saturation * Math.sin(b.hue * DEG);
  const x = ax + (bx - ax) * t;
  const y = ay + (by - ay) * t;
  const sat = Math.hypot(x, y);
  // With (almost) no saturation the angle is meaningless: keep the target hue
  // so the wheel handle does not jump to 0°.
  let hue = sat < 1e-6 ? (b.saturation > 0 ? b.hue : a.hue) : wrapHue(Math.atan2(y, x) / DEG);
  if (Math.abs(hue - Math.round(hue)) < 1e-9) hue = Math.round(hue) % 360;
  const lum = a.luminance + (b.luminance - a.luminance) * t;
  return {
    hue,
    saturation: Math.min(100, sat),
    luminance: Math.max(-100, Math.min(100, lum)),
  };
}

function lerpAdjustments(a: LocalAdjustments, b: LocalAdjustments, t: number): LocalAdjustments {
  const out = { ...b };
  for (const k of Object.keys(LOCAL_SPECS) as (keyof LocalAdjustments)[]) {
    const spec = LOCAL_SPECS[k];
    const v = a[k] + (b[k] - a[k]) * t;
    out[k] = v < spec.min ? spec.min : v > spec.max ? spec.max : v;
  }
  return out;
}

function lerpMasks(a: Mask[], b: Mask[], t: number): Mask[] {
  const byId = new Map(a.map((m) => [m.id, m] as const));
  const neutral = createDefaultLocalAdjustments();
  return b.map((mb) => {
    const ma = byId.get(mb.id);
    const m = structuredClone(mb);
    m.adjustments = lerpAdjustments(ma ? ma.adjustments : neutral, mb.adjustments, t);
    if (ma) m.amount = Math.max(0, Math.min(100, ma.amount + (mb.amount - ma.amount) * t));
    return m;
  });
}
