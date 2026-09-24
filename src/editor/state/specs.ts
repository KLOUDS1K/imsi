/**
 * Range specs for every numeric field of EditParams.
 *
 * PARAM_SPECS (defaults.ts) covers the slider fields; LOCAL_SPECS covers mask
 * adjustments. The rest (HSL, grading wheels, parametric curve, crop rect,
 * mask amount) is described here so clamping / lerping / labelling can treat
 * every numeric leaf uniformly via `specForPath`.
 */
import { LOCAL_SPECS, PARAM_SPECS, type ParamSpec } from '@/editor/defaults';
import type { LocalAdjustments } from '@/editor/types';

const PM100: ParamSpec = { min: -100, max: 100, step: 1, def: 0 };
const P0_100: ParamSpec = { min: 0, max: 100, step: 1, def: 0 };
const HUE360: ParamSpec = { min: 0, max: 360, step: 1, def: 0, unit: '°' };
const UNIT: ParamSpec = { min: 0, max: 1, step: 0.001, def: 0 };
/** Minimum crop extent (fraction of the frame) so a crop never collapses. */
export const MIN_CROP = 0.01;

const EXTRA_SPECS: Record<string, ParamSpec> = {
  'toneCurve.parametric.highlights': PM100,
  'toneCurve.parametric.lights': PM100,
  'toneCurve.parametric.darks': PM100,
  'toneCurve.parametric.shadows': PM100,
  'toneCurve.parametric.split1': { min: 0, max: 100, step: 1, def: 25 },
  'toneCurve.parametric.split2': { min: 0, max: 100, step: 1, def: 50 },
  'toneCurve.parametric.split3': { min: 0, max: 100, step: 1, def: 75 },
  'crop.x': UNIT,
  'crop.y': UNIT,
  'crop.w': { min: MIN_CROP, max: 1, step: 0.001, def: 1 },
  'crop.h': { min: MIN_CROP, max: 1, step: 0.001, def: 1 },
};

const HSL_RE = /^hsl\.(red|orange|yellow|green|aqua|blue|purple|magenta)\.(hue|saturation|luminance)$/;
const WHEEL_RE = /^colorGrading\.(shadows|midtones|highlights|global)\.(hue|saturation|luminance)$/;
const MASK_ADJ_RE = /^masks\.\d+\.adjustments\.(\w+)$/;
const MASK_AMOUNT_RE = /^masks\.\d+\.amount$/;

/** Range spec for any numeric path of EditParams (undefined for non-numeric / free fields). */
export function specForPath(path: string): ParamSpec | undefined {
  const direct = PARAM_SPECS[path] ?? EXTRA_SPECS[path];
  if (direct) return direct;
  if (HSL_RE.test(path)) return PM100;
  const w = WHEEL_RE.exec(path);
  if (w) return w[2] === 'hue' ? HUE360 : w[2] === 'saturation' ? P0_100 : PM100;
  const m = MASK_ADJ_RE.exec(path);
  if (m && Object.prototype.hasOwnProperty.call(LOCAL_SPECS, m[1])) return LOCAL_SPECS[m[1] as keyof LocalAdjustments];
  if (MASK_AMOUNT_RE.test(path)) return { min: 0, max: 100, step: 1, def: 100 };
  return undefined;
}

/** Hue fields that wrap around instead of clamping. */
export function isWrappingHue(path: string): boolean {
  return WHEEL_RE.test(path) && path.endsWith('.hue');
}

export function clampToSpec(path: string, v: number): number {
  if (isWrappingHue(path)) return wrapHue(v);
  const spec = specForPath(path);
  if (!spec) return v;
  return v < spec.min ? spec.min : v > spec.max ? spec.max : v;
}

export function wrapHue(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

/** Allowed values of enum-like string fields. */
export const ENUMS: Record<string, readonly string[]> = {
  'whiteBalance.mode': ['as-shot', 'auto', 'custom'],
  'transform.upright': ['off', 'auto', 'level', 'vertical', 'full'],
  'crop.aspect': ['free', 'original', '1:1', '3:2', '4:3', '5:4', '16:9', '4:5', '2:3', 'custom'],
  'crop.overlay': ['none', 'thirds', 'golden-ratio', 'golden-spiral', 'grid', 'diagonal'],
};

/** Paths of the four point curves. */
export const CURVE_PATHS: ReadonlySet<string> = new Set(['toneCurve.rgb', 'toneCurve.red', 'toneCurve.green', 'toneCurve.blue']);
