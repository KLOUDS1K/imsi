/**
 * Colorimetry for the export color spaces: RGB→XYZ matrices derived from the
 * primaries' chromaticities, Bradford chromatic adaptation (for ICC's D50 PCS)
 * and the transfer curves (sRGB piecewise curve for sRGB and Display P3,
 * pure 563/256 gamma for Adobe RGB). Matrices are row-major 3×3 number[9].
 */
import { ADOBE_RGB_GAMMA, linearToSrgb, srgbToLinear } from '@/editor/color/math';
import type { ExportColorSpace } from '@/editor/types';

type Mat3 = number[];
type XY = readonly [number, number];

interface SpaceDef {
  r: XY;
  g: XY;
  b: XY;
  white: XY;
}

/** CIE 1931 xy chromaticities (all three spaces use a D65 white). */
export const PRIMARIES: Record<ExportColorSpace, SpaceDef> = {
  srgb: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: [0.3127, 0.329] },
  'display-p3': { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: [0.3127, 0.329] },
  'adobe-rgb': { r: [0.64, 0.33], g: [0.21, 0.71], b: [0.15, 0.06], white: [0.3127, 0.329] },
};

/** ICC PCS illuminant (D50) as written in every ICC header / wtpt tag. */
export const ICC_D50: readonly [number, number, number] = [0.9642, 1.0, 0.8249];

export const xyToXYZ = (x: number, y: number): [number, number, number] => [x / y, 1, (1 - x - y) / y];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function mulVec3(m: Mat3, v: readonly number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const k = 1 / det;
  return [
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ];
}

/**
 * Linear RGB → XYZ (relative to the space's own white, Y_white = 1).
 * Standard derivation: columns are the primaries' XYZ scaled so that
 * RGB (1,1,1) maps to the white point.
 */
export function rgbToXyzMatrix(space: ExportColorSpace): Mat3 {
  const p = PRIMARIES[space];
  const R = xyToXYZ(p.r[0], p.r[1]);
  const G = xyToXYZ(p.g[0], p.g[1]);
  const B = xyToXYZ(p.b[0], p.b[1]);
  const P: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const W = xyToXYZ(p.white[0], p.white[1]);
  const S = mulVec3(invert3(P), W);
  return [
    P[0] * S[0], P[1] * S[1], P[2] * S[2],
    P[3] * S[0], P[4] * S[1], P[5] * S[2],
    P[6] * S[0], P[7] * S[1], P[8] * S[2],
  ];
}

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford von-Kries adaptation matrix from one white (XYZ) to another. */
export function bradford(src: readonly number[], dst: readonly number[]): Mat3 {
  const s = mulVec3(BRADFORD, src);
  const d = mulVec3(BRADFORD, dst);
  const D: Mat3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
  return mul3(invert3(BRADFORD), mul3(D, BRADFORD));
}

/** Linear RGB → XYZ adapted to the ICC D50 PCS (the rXYZ/gXYZ/bXYZ columns). */
export function rgbToXyzD50Matrix(space: ExportColorSpace): Mat3 {
  const w = PRIMARIES[space].white;
  return mul3(bradford(xyToXYZ(w[0], w[1]), ICC_D50), rgbToXyzMatrix(space));
}

/* ---------------- transfer curves ---------------- */

export function decodeTransfer(space: ExportColorSpace, v: number): number {
  if (space === 'adobe-rgb') return v <= 0 ? 0 : Math.pow(v, ADOBE_RGB_GAMMA);
  return srgbToLinear(v);
}

export function encodeTransfer(space: ExportColorSpace, v: number): number {
  if (space === 'adobe-rgb') return v <= 0 ? 0 : Math.pow(v, 1 / ADOBE_RGB_GAMMA);
  return linearToSrgb(v);
}

const linLutCache = new Map<string, Uint16Array>();

/**
 * Lookup table: encoded code value (8- or 16-bit) → linear 16-bit value.
 * 65536 entries for 16-bit input (128 KB, cached per space).
 */
export function linearizeLut(space: ExportColorSpace, bitDepth: 8 | 16): Uint16Array {
  const key = `${space}:${bitDepth}`;
  const hit = linLutCache.get(key);
  if (hit) return hit;
  const n = bitDepth === 8 ? 256 : 65536;
  const lut = new Uint16Array(n);
  const inv = 1 / (n - 1);
  for (let i = 0; i < n; i++) lut[i] = Math.round(decodeTransfer(space, i * inv) * 65535);
  linLutCache.set(key, lut);
  return lut;
}
