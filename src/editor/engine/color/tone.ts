/**
 * Tone math: CPU reference implementations of the curves used by the
 * DEVELOP and LOCAL shaders, plus the GLSL mirror generated from the same
 * constants (GLSL_TONE).
 *
 * Domains
 * - "tone space" L: stops relative to middle grey with a linear toe
 *   (see TONE_E0). Local tone mapping (highlights/shadows) and presence work
 *   here; resulting ΔL values are applied as a pure luminance ratio in linear
 *   light so hue and saturation are preserved and black stays black.
 * - "perceptual" p: sRGB-encoded luminance. Whites/blacks and contrast are
 *   curves in this domain (it matches how people judge white/black points).
 */
import { clamp, linearToSrgb, smoothstep, srgbToLinear } from '../../color/math';
import {
  BLACKS_HI,
  BLACKS_KNEE,
  BLACKS_LIFT,
  CONTRAST_END_SLOPE,
  CONTRAST_MID_SLOPE,
  HIGHLIGHTS_EV,
  HL_FULL,
  HL_POS_TAPER,
  HL_POS_TAPER_HI,
  HL_POS_TAPER_LO,
  HL_RECOVER_SLOPE,
  HL_RECOVER_START,
  HL_START,
  SHADOWS_EV,
  SH_END,
  SH_FLOOR_HI,
  SH_FLOOR_LO,
  SH_FLOOR_W,
  SH_FULL,
  TONE_E0,
  TONE_LOG_MID,
  TONE_MID,
  WHITES_GAIN,
  WHITES_HI,
  WHITES_LO,
  glslFloat as f,
} from './constants';

/** Perceptual position of middle grey (pivot of the contrast curve). */
export const CONTRAST_PIVOT = linearToSrgb(TONE_MID);

export function toneL(y: number): number {
  return Math.log2(Math.max(y, 0) + TONE_E0) - TONE_LOG_MID;
}

export function toneY(l: number): number {
  return Math.max(Math.pow(2, l + TONE_LOG_MID) - TONE_E0, 0);
}

/** C1 ramp: 0 below −0.5, identity above 0.5, parabola in between. */
export function softRamp(u: number): number {
  if (u <= -0.5) return 0;
  if (u >= 0.5) return u;
  return 0.5 * (u + 0.5) * (u + 0.5);
}

/** Smoothly limits |d| to about k (≈ d for |d| ≪ k). Used to tame halos. */
export function softLimit(d: number, k: number): number {
  return d / Math.sqrt(1 + (d * d) / (k * k));
}

/** Weight of the shadows slider at tone-space base x. */
export function shadowsWeight(x: number): number {
  return (1 - smoothstep(SH_FULL, SH_END, x)) * (SH_FLOOR_W + (1 - SH_FLOOR_W) * smoothstep(SH_FLOOR_LO, SH_FLOOR_HI, x));
}

/** ΔL (EV) of the shadows slider s ∈ [-1, 1] at base x. */
export function shadowsDelta(x: number, s: number): number {
  return s * SHADOWS_EV * shadowsWeight(x);
}

/**
 * ΔL (EV) of the highlights slider h ∈ [-1, 1] at base x. Negative values
 * also compress everything above white progressively (highlight recovery of
 * unclamped RAW data); the slope stays > −1 so the mapping is monotone.
 */
export function highlightsDelta(x: number, h: number): number {
  const w = HIGHLIGHTS_EV * smoothstep(HL_START, HL_FULL, x);
  if (h >= 0) return h * w * (1 - HL_POS_TAPER * smoothstep(HL_POS_TAPER_LO, HL_POS_TAPER_HI, x));
  return h * (w + HL_RECOVER_SLOPE * softRamp(x - HL_RECOVER_START));
}

/** Whites w ∈ [-1, 1] on perceptual luminance p (moves the white point, soft into the mid-tones). */
export function whitesCurve(p: number, w: number): number {
  return p * (1 + w * WHITES_GAIN * smoothstep(WHITES_LO, WHITES_HI, p));
}

/** Soft floor: identity above k, exponential approach to 0 below (C1 at k). */
export function softFloor(x: number, k: number): number {
  return x >= k ? x : k * Math.exp((x - k) / k);
}

/** Blacks b ∈ [-1, 1] on perceptual luminance p (moves the black point with a soft knee). */
export function blacksCurve(p: number, b: number): number {
  if (b === 0) return p;
  const shift = BLACKS_LIFT * (1 - smoothstep(0, BLACKS_HI, p));
  if (b > 0) return p + b * shift;
  return softFloor(p + b * shift, BLACKS_KNEE * -b);
}

/**
 * Contrast c ∈ [-1, 1]: an S-curve pinned at 0, middle grey and 1, made of
 * two cubic Hermite halves that share the slope at the pivot (C1). Slopes are
 * well inside the Fritsch–Carlson region so the curve is monotone. Values
 * above 1 continue with the end slope.
 */
export function contrastCurve(p: number, c: number): number {
  if (c === 0) return p;
  const pv = CONTRAST_PIVOT;
  const m = 1 + CONTRAST_MID_SLOPE * c;
  const m0 = 1 - CONTRAST_END_SLOPE * c;
  const herm = (u: number) => {
    const u2 = u * u;
    const u3 = u2 * u;
    return 3 * u2 - 2 * u3 + m0 * (u3 - 2 * u2 + u) + m * (u3 - u2);
  };
  if (p <= 0) return p * m0;
  if (p >= 1) return 1 + (p - 1) * m0;
  if (p < pv) return pv * herm(p / pv);
  return 1 - (1 - pv) * herm((1 - p) / (1 - pv));
}

/** Whites → blacks → contrast on perceptual luminance. */
export function globalToneCurve(p: number, whites: number, blacks: number, contrast: number): number {
  return contrastCurve(blacksCurve(whitesCurve(p, whites), blacks), contrast);
}

/** Same as globalToneCurve but on linear luminance (encode → curve → decode). */
export function globalToneCurveLinear(y: number, whites: number, blacks: number, contrast: number): number {
  const p = linearToSrgb(Math.max(y, 0));
  const q = globalToneCurve(p, whites, blacks, contrast);
  return q <= 0 ? 0 : srgbToLinear(q);
}

/** Tone-space L → display value (for tuning tables / tests). */
export function toneToDisplay(l: number): number {
  return clamp(linearToSrgb(toneY(l)), 0, 4);
}

/* ------------------------------------------------------------------ */
/* GLSL mirror                                                         */
/* ------------------------------------------------------------------ */

/**
 * GLSL versions of everything above. Requires GLSL_COLOR_LIB (for
 * linearToSrgb1 / srgbToLinear1 / luma) to be included first.
 */
export const GLSL_TONE = /* glsl */ `
const float TONE_E0 = ${f(TONE_E0)};
const float TONE_LOG_MID = ${f(TONE_LOG_MID)};
const float CONTRAST_PIVOT = ${f(CONTRAST_PIVOT)};

float toneL(float y) { return log2(max(y, 0.0) + TONE_E0) - TONE_LOG_MID; }
float toneY(float l) { return max(exp2(l + TONE_LOG_MID) - TONE_E0, 0.0); }

float softRamp(float u) { return u <= -0.5 ? 0.0 : (u >= 0.5 ? u : 0.5 * (u + 0.5) * (u + 0.5)); }
float softLimit(float d, float k) { return d * inversesqrt(1.0 + (d * d) / (k * k)); }

float shadowsDelta(float x, float s) {
  float w = (1.0 - smoothstep(${f(SH_FULL)}, ${f(SH_END)}, x))
          * (${f(SH_FLOOR_W)} + ${f(1 - SH_FLOOR_W)} * smoothstep(${f(SH_FLOOR_LO)}, ${f(SH_FLOOR_HI)}, x));
  return s * ${f(SHADOWS_EV)} * w;
}

float highlightsDelta(float x, float h) {
  float w = ${f(HIGHLIGHTS_EV)} * smoothstep(${f(HL_START)}, ${f(HL_FULL)}, x);
  if (h >= 0.0) return h * w * (1.0 - ${f(HL_POS_TAPER)} * smoothstep(${f(HL_POS_TAPER_LO)}, ${f(HL_POS_TAPER_HI)}, x));
  return h * (w + ${f(HL_RECOVER_SLOPE)} * softRamp(x - ${f(HL_RECOVER_START)}));
}

float whitesCurve(float p, float w) {
  return p * (1.0 + w * ${f(WHITES_GAIN)} * smoothstep(${f(WHITES_LO)}, ${f(WHITES_HI)}, p));
}

float softFloor(float x, float k) { return x >= k ? x : k * exp((x - k) / k); }

float blacksCurve(float p, float b) {
  if (b == 0.0) return p;
  float shift = ${f(BLACKS_LIFT)} * (1.0 - smoothstep(0.0, ${f(BLACKS_HI)}, p));
  if (b > 0.0) return p + b * shift;
  return softFloor(p + b * shift, ${f(BLACKS_KNEE)} * -b);
}

float contrastHerm(float u, float m0, float m) {
  float u2 = u * u;
  float u3 = u2 * u;
  return 3.0 * u2 - 2.0 * u3 + m0 * (u3 - 2.0 * u2 + u) + m * (u3 - u2);
}

float contrastCurve(float p, float c) {
  if (c == 0.0) return p;
  float m = 1.0 + ${f(CONTRAST_MID_SLOPE)} * c;
  float m0 = 1.0 - ${f(CONTRAST_END_SLOPE)} * c;
  if (p <= 0.0) return p * m0;
  if (p >= 1.0) return 1.0 + (p - 1.0) * m0;
  if (p < CONTRAST_PIVOT) return CONTRAST_PIVOT * contrastHerm(p / CONTRAST_PIVOT, m0, m);
  return 1.0 - (1.0 - CONTRAST_PIVOT) * contrastHerm((1.0 - p) / (1.0 - CONTRAST_PIVOT), m0, m);
}

// Whites → blacks → contrast on LINEAR luminance; returns the new linear luminance.
float globalToneLinear(float y, float whites, float blacks, float contrast) {
  float p = linearToSrgb1(max(y, 0.0));
  p = contrastCurve(blacksCurve(whitesCurve(p, whites), blacks), contrast);
  return p <= 0.0 ? 0.0 : srgbToLinear1(p);
}

// Re-light linear rgb from luminance y to y2. Darkening and lifts of up to
// one stop scale the colour (hue and saturation kept); whatever a lift adds
// beyond that is neutral light, like a matte / veil, so a lifted black never
// picks up an amplified noise hue.
vec3 relight(vec3 c, float y, float y2) {
  if (y2 <= y) return y > 1e-7 ? c * (y2 / y) : c;
  float ratioPart = y * min(y2 / max(y, 1e-7), 2.0);
  vec3 lifted = y > 1e-7 ? c * (ratioPart / y) : c;
  return lifted + vec3(max(y2 - ratioPart, 0.0));
}
`;
