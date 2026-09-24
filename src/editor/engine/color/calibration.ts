/**
 * Camera calibration: red / green / blue primary hue & saturation → 3×3
 * matrix on linear sRGB, plus the shadows tint parameter.
 *
 * Each working-space primary (the unit vectors R, G, B) is split into its grey
 * component (mean of its channels, i.e. the projection on the (1,1,1) axis)
 * and a chroma vector orthogonal to it. The hue slider rotates the chroma
 * vector about the grey axis (Rodrigues; positive = towards increasing hue:
 * red → orange, green → cyan, blue → purple, matching Lightroom's slider
 * gradients), the saturation slider scales it. The new primaries become the
 * matrix columns, and — exactly like deriving an RGB→XYZ matrix from
 * primaries and a white point — each column is rescaled so that white
 * (1,1,1) still maps to white. Neutral colours therefore stay neutral.
 */
import type { CalibrationParams } from '../../types';
import { CAL_HUE_DEG, CAL_SAT, CAL_SHADOW_TINT_EV } from './constants';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function isCalibrationIdentity(c: CalibrationParams): boolean {
  return (
    c.shadowsTint === 0 &&
    c.redHue === 0 &&
    c.redSaturation === 0 &&
    c.greenHue === 0 &&
    c.greenSaturation === 0 &&
    c.blueHue === 0 &&
    c.blueSaturation === 0
  );
}

type Vec3 = [number, number, number];

/** Rotate + scale the chroma of a primary about the grey axis. */
function adjustPrimary(p: Vec3, hue: number, sat: number): Vec3 {
  const g = (p[0] + p[1] + p[2]) / 3;
  const c: Vec3 = [p[0] - g, p[1] - g, p[2] - g];
  const th = ((hue / 100) * CAL_HUE_DEG * Math.PI) / 180;
  const k = 1 / Math.sqrt(3);
  // n × c with n = (1,1,1)/√3; c ⟂ n so the Rodrigues term n(n·c) vanishes.
  const x: Vec3 = [k * (c[2] - c[1]), k * (c[0] - c[2]), k * (c[1] - c[0])];
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const s = Math.max(1 + (sat / 100) * CAL_SAT, 0);
  return [g + (c[0] * cs + x[0] * sn) * s, g + (c[1] * cs + x[1] * sn) * s, g + (c[2] * cs + x[2] * sn) * s];
}

function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/** Solve m · x = b (Cramer's rule; m row-major). Returns null when singular. */
function solve3(m: Mat3, b: Vec3): Vec3 | null {
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return null;
  const col = (i: number): Mat3 => {
    const r = [...m] as Mat3;
    r[i] = b[0];
    r[3 + i] = b[1];
    r[6 + i] = b[2];
    return r;
  };
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

/** Row-major 3×3 matrix applied to linear rgb column vectors (out = M · rgb). */
export function calibrationMatrix(c: CalibrationParams): Mat3 {
  const r = adjustPrimary([1, 0, 0], c.redHue, c.redSaturation);
  const g = adjustPrimary([0, 1, 0], c.greenHue, c.greenSaturation);
  const b = adjustPrimary([0, 0, 1], c.blueHue, c.blueSaturation);
  // Columns = new primaries.
  const m: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const w = solve3(m, [1, 1, 1]);
  if (!w || w.some((v) => !(v > 0))) return [...IDENTITY3];
  return [m[0] * w[0], m[1] * w[1], m[2] * w[2], m[3] * w[0], m[4] * w[1], m[5] * w[2], m[6] * w[0], m[7] * w[1], m[8] * w[2]];
}

/** Stops of green removed (positive = magenta) in the deepest shadows. */
export function shadowTintStops(c: CalibrationParams): number {
  return (c.shadowsTint / 100) * CAL_SHADOW_TINT_EV;
}

export function applyMat3(m: Mat3, rgb: Vec3): Vec3 {
  return [
    m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2],
    m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2],
    m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2],
  ];
}
