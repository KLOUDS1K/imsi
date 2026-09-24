/**
 * Color grading (shadows / midtones / highlights / global wheels).
 *
 * Works on display-referred (sRGB-encoded) values. Region weights come from
 * the encoded luminance y: shadows fall off around the lower split, highlights
 * rise around the upper split, midtones take the rest. `blending` sets the
 * transition half-width (overlap), `balance` slides both splits (positive
 * favours the highlights wheel). Weights always sum to 1.
 *
 * Each wheel adds a luminance-neutral chroma offset towards its hue (scaled
 * by saturation and by √y so pure black stays black) and its luminance slider
 * lifts (towards white, matte-like) or darkens (multiplicatively) its range.
 */
import { hsvToRgb, luminance, smoothstep } from '../../color/math';
import type { ColorGradingParams, GradeWheel } from '../../types';
import {
  GRADE_BALANCE_SHIFT,
  GRADE_LUM_DARKEN,
  GRADE_LUM_LIFT,
  GRADE_SPLIT_HI,
  GRADE_SPLIT_LO,
  GRADE_TINT,
  GRADE_WIDTH_MAX,
  GRADE_WIDTH_MIN,
  glslFloat as f,
} from './constants';

export interface GradeSplit {
  lo: number;
  hi: number;
  halfWidth: number;
}

export function gradeSplit(g: Pick<ColorGradingParams, 'blending' | 'balance'>): GradeSplit {
  const shift = (g.balance / 100) * GRADE_BALANCE_SHIFT;
  const halfWidth = GRADE_WIDTH_MIN + (GRADE_WIDTH_MAX - GRADE_WIDTH_MIN) * (g.blending / 100);
  return { lo: GRADE_SPLIT_LO - shift, hi: GRADE_SPLIT_HI - shift, halfWidth };
}

/** [shadows, midtones, highlights] weights at encoded luminance y. */
export function gradeWeights(y: number, split: GradeSplit): [number, number, number] {
  const ws = 1 - smoothstep(split.lo - split.halfWidth, split.lo + split.halfWidth, y);
  const wh = smoothstep(split.hi - split.halfWidth, split.hi + split.halfWidth, y);
  return [ws, Math.max(1 - ws - wh, 0), wh];
}

/**
 * Luminance-neutral (Rec.709 on encoded values) chroma direction of a hue at
 * full saturation, e.g. red → (0.787, −0.213, −0.213).
 */
export function tintDirection(hueDeg: number): [number, number, number] {
  const [r, g, b] = hsvToRgb(hueDeg, 1, 1);
  const y = luminance(r, g, b);
  return [r - y, g - y, b - y];
}

/** vec4(tint.rgb, luminance −1..1) for one wheel. */
export function wheelUniform(w: GradeWheel): number[] {
  const d = tintDirection(w.hue);
  const s = (w.saturation / 100) * GRADE_TINT;
  return [d[0] * s, d[1] * s, d[2] * s, w.luminance / 100];
}

export function isWheelIdentity(w: GradeWheel): boolean {
  return w.saturation === 0 && w.luminance === 0;
}

export function isGradingIdentity(g: ColorGradingParams): boolean {
  return isWheelIdentity(g.shadows) && isWheelIdentity(g.midtones) && isWheelIdentity(g.highlights) && isWheelIdentity(g.global);
}

export function gradingUniforms(g: ColorGradingParams): Record<string, number[]> {
  const split = gradeSplit(g);
  return {
    uGradeShadows: wheelUniform(g.shadows),
    uGradeMidtones: wheelUniform(g.midtones),
    uGradeHighlights: wheelUniform(g.highlights),
    uGradeGlobal: wheelUniform(g.global),
    uGradeSplit: [split.lo, split.hi, split.halfWidth],
  };
}

/** GLSL: `vec3 applyGrade(vec3 e)` — declares its uniforms. Needs GLSL_COLOR_OPS. */
export const GLSL_GRADE = /* glsl */ `
uniform vec4 uGradeShadows;
uniform vec4 uGradeMidtones;
uniform vec4 uGradeHighlights;
uniform vec4 uGradeGlobal;
uniform vec3 uGradeSplit;

vec3 applyGrade(vec3 e) {
  float y = encLuma(e);
  float ws = 1.0 - smoothstep(uGradeSplit.x - uGradeSplit.z, uGradeSplit.x + uGradeSplit.z, y);
  float wh = smoothstep(uGradeSplit.y - uGradeSplit.z, uGradeSplit.y + uGradeSplit.z, y);
  float wm = max(1.0 - ws - wh, 0.0);
  vec3 tint = uGradeShadows.rgb * ws + uGradeMidtones.rgb * wm + uGradeHighlights.rgb * wh + uGradeGlobal.rgb;
  e += tint * sqrt(clamp(y, 0.0, 1.0));
  float lum = uGradeShadows.a * ws + uGradeMidtones.a * wm + uGradeHighlights.a * wh + uGradeGlobal.a;
  if (lum > 0.0) e += max(1.0 - e, vec3(0.0)) * (lum * ${f(GRADE_LUM_LIFT)});
  else if (lum < 0.0) e *= max(1.0 + lum * ${f(GRADE_LUM_DARKEN)}, 0.0);
  return e;
}
`;
