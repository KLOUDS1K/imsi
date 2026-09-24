/**
 * Shared color math. The CPU functions and the GLSL snippets below implement
 * the SAME formulas — engine shaders, analysis (auto WB/tone), style learning
 * and UI pickers must all go through these so a value means the same thing
 * everywhere.
 */
import type { RGB } from '../types';

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* ---------------- Transfer functions ---------------- */

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** 256-entry sRGB(8-bit) → linear lookup. */
export const SRGB8_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

/** Rec.709 / sRGB relative luminance of LINEAR rgb. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ---------------- White balance ---------------- */

/** log2 gain per 100 units of temperature (applied +R / -B). */
export const WB_TEMP_STOPS = 0.9;
/** log2 gain per 100 units of tint (applied -G). */
export const WB_TINT_STOPS = 0.6;

/**
 * Channel multipliers (for LINEAR rgb) for the relative temperature/tint
 * sliders (±100). Normalized so a neutral gray keeps its luminance.
 */
export function wbGains(temperature: number, tint: number): RGB {
  const r = Math.pow(2, (WB_TEMP_STOPS * temperature) / 100);
  const b = Math.pow(2, (-WB_TEMP_STOPS * temperature) / 100);
  const g = Math.pow(2, (-WB_TINT_STOPS * tint) / 100);
  const n = luminance(r, g, b);
  return [r / n, g / n, b / n];
}

/**
 * Inverse of wbGains: temperature/tint that turn the given LINEAR rgb sample
 * (something that should be neutral gray) into a neutral gray.
 * Results are clamped to ±100.
 */
export function tempTintFromNeutral(rgb: RGB): { temperature: number; tint: number } {
  const eps = 1e-6;
  const [r, g, b] = rgb.map((v) => Math.max(v, eps)) as RGB;
  const temperature = (100 * Math.log2(b / r)) / (2 * WB_TEMP_STOPS);
  const tint = (-100 * Math.log2(Math.sqrt(r * b) / g)) / WB_TINT_STOPS;
  return { temperature: clamp(temperature, -100, 100), tint: clamp(tint, -100, 100) };
}

/* ---------------- HSV / HSL ---------------- */

/** rgb 0..1 → [h 0..360, s 0..1, v 0..1] */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max <= 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: RGB;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = v - c;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** rgb 0..1 → [h 0..360, s 0..1, l 0..1] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: RGB;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Smallest signed angular distance a→b in degrees (-180..180]. */
export function hueDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/* ---------------- Gamut / primaries (linear, D65) ---------------- */

/** Row-major 3×3 matrices converting LINEAR sRGB (Rec.709 primaries) to other spaces. */
export const MATRIX_SRGB_TO: Record<'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto', number[]> = {
  srgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  'display-p3': [0.8224621, 0.177538, 0.0, 0.0331941, 0.9668058, 0.0, 0.0170827, 0.0723974, 0.9105199],
  'adobe-rgb': [0.7151627, 0.2848373, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0411705, 0.9588295],
  // ProPhoto is D50; this includes a Bradford D65→D50 adaptation.
  prophoto: [0.5293459, 0.3300437, 0.1406104, 0.0983812, 0.8734015, 0.0282173, 0.0168869, 0.1176716, 0.8654415],
};

/** Inverse matrices: other space (linear) → linear sRGB. */
export const MATRIX_TO_SRGB: Record<'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto', number[]> = {
  srgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  'display-p3': [1.2249401, -0.2249404, 0.0, -0.0420569, 1.0420571, 0.0, -0.0196376, -0.0786361, 1.0982735],
  'adobe-rgb': [1.3982832, -0.3982831, 0.0, 0.0, 1.0, 0.0, 0.0, -0.0429383, 1.0429383],
  prophoto: [2.0341926, -0.7274198, -0.3067728, -0.2288086, 1.2317266, -0.0029180, -0.0085601, -0.1532838, 1.1618439],
};

export function applyMatrix3(m: number[], r: number, g: number, b: number): RGB {
  return [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
}

/** Adobe RGB (1998) transfer: pure gamma 563/256. */
export const ADOBE_RGB_GAMMA = 563 / 256;

/* ---------------- GLSL mirrors ---------------- */

/**
 * GLSL ES 3.00 helpers (no #version / precision lines — include after them).
 * Same formulas as the TS functions above.
 */
export const GLSL_COLOR_LIB = /* glsl */ `
const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA709); }

float srgbToLinear1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float linearToSrgb1(float v) { return v <= 0.0 ? 0.0 : (v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055); }
vec3 srgbToLinear(vec3 c) { return vec3(srgbToLinear1(c.r), srgbToLinear1(c.g), srgbToLinear1(c.b)); }
vec3 linearToSrgb(vec3 c) { return vec3(linearToSrgb1(c.r), linearToSrgb1(c.g), linearToSrgb1(c.b)); }

const float WB_TEMP_STOPS = ${WB_TEMP_STOPS.toFixed(4)};
const float WB_TINT_STOPS = ${WB_TINT_STOPS.toFixed(4)};
vec3 wbGains(float temperature, float tint) {
  float r = exp2( WB_TEMP_STOPS * temperature / 100.0);
  float b = exp2(-WB_TEMP_STOPS * temperature / 100.0);
  float g = exp2(-WB_TINT_STOPS * tint / 100.0);
  vec3 k = vec3(r, g, b);
  return k / dot(k, LUMA709);
}

// h in 0..1 (fraction of 360°), s, v in 0..1
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
// signed hue distance in degrees, -180..180
float hueDelta(float a, float b) { float d = mod(b - a + 540.0, 360.0) - 180.0; return d; }
`;
