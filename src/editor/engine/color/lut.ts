/**
 * Tone-curve LUT helpers for the orchestrator.
 *
 * DEVELOP samples `uCurveLut` = color/curves.buildCurveLut(params.toneCurve)
 * (1024×1 RGBA float; R/G/B = per-channel combined curves, A = master).
 * Rebuilding and re-uploading it every frame is wasteful, so the orchestrator
 * should cache the texture by `curveLutKey(params)`.
 */
import { buildCurveLut, isIdentityToneCurve } from '../../color/curves';
import type { CurvePoint, EditParams } from '../../types';

/** Texels of the curve LUT (width; height is 1). */
export const CURVE_LUT_SIZE = 1024;

const pts = (p: CurvePoint[]) => p.map((q) => `${q.x},${q.y}`).join(';');

/** Stable string key of everything that affects the curve LUT. */
export function curveLutKey(params: EditParams): string {
  const tc = params.toneCurve;
  const pc = tc.parametric;
  return [
    `p${pc.highlights},${pc.lights},${pc.darks},${pc.shadows},${pc.split1},${pc.split2},${pc.split3}`,
    `m${pts(tc.rgb)}`,
    `r${pts(tc.red)}`,
    `g${pts(tc.green)}`,
    `b${pts(tc.blue)}`,
  ].join('|');
}

export function isCurveIdentity(params: EditParams): boolean {
  return isIdentityToneCurve(params.toneCurve);
}

/** The LUT data DEVELOP expects in `uCurveLut` (RGBA32F, CURVE_LUT_SIZE × 1). */
export function buildDevelopCurveLut(params: EditParams): Float32Array {
  return buildCurveLut(params.toneCurve, CURVE_LUT_SIZE);
}
