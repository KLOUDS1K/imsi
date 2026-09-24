/**
 * RAW colour helpers shared by the LibRaw path and the built-in demosaic:
 * LibRaw's output tone curve (and its exact inverse), CFA pattern decoding,
 * white-balance multipliers, camera → output matrices and LibRaw's `flip`.
 */
import { MATRIX_SRGB_TO } from '../color/math';

/* ------------------------------------------------------------------ */
/* LibRaw output curve                                                 */
/* ------------------------------------------------------------------ */

/**
 * LibRaw's `gamma_curve(pwr, ts)` parameters g[0..5] (port of the dcraw
 * solver): a power segment r^pwr·(1+g4) − g4 above the linear toe r·ts,
 * joined continuously at r = g3. Defaults (0.45, 4.5) = BT.709, which is
 * what libraw-wasm always applies — its `gamm` setting is ignored by the
 * build we ship (verified: output identical for gamm [1,1], [2.2,0], [0.2,0]).
 */
export function libRawGamma(pwr = 0.45, ts = 4.5): number[] {
  const g = [pwr, ts, 0, 0, 0, 0];
  const bnd = [0, 0];
  bnd[g[1] >= 1 ? 1 : 0] = 1;
  if (g[1] && (g[1] - 1) * (g[0] - 1) <= 0) {
    for (let i = 0; i < 48; i++) {
      g[2] = (bnd[0] + bnd[1]) / 2;
      if (g[0]) bnd[(Math.pow(g[2] / g[1], -g[0]) - 1) / g[0] - 1 / g[2] > -1 ? 1 : 0] = g[2];
      else bnd[g[2] / Math.exp(1 - 1 / g[2]) < g[1] ? 1 : 0] = g[2];
    }
    g[3] = g[2] / g[1];
    if (g[0]) g[4] = g[2] * (1 / g[0] - 1);
  }
  return g;
}

let invLut: Uint16Array | null = null;

/**
 * 16-bit LibRaw-encoded value → 16-bit LINEAR value. LibRaw computes
 * out = 0x10000 · f(v / 0x10000) with no auto-brightening, so the inverse is
 * v = 0x10000 · f⁻¹(out / 0x10000) — dcraw's own inverse branch.
 */
export function libRawLinearizeLut(): Uint16Array {
  if (invLut) return invLut;
  const g = libRawGamma();
  const lut = new Uint16Array(65536);
  for (let e = 0; e < 65536; e++) {
    const x = e / 65536;
    const r = x < g[2] ? x / g[1] : Math.pow((x + g[4]) / (1 + g[4]), 1 / g[0]);
    lut[e] = Math.min(65535, Math.round(r * 65536));
  }
  // The top code (0xffff) is the clip value: keep it at full scale.
  lut[65535] = 65535;
  invLut = lut;
  return lut;
}

/* ------------------------------------------------------------------ */
/* CFA                                                                 */
/* ------------------------------------------------------------------ */

/** LibRaw FC(row, col): colour index into `cdesc` of a filters bitmask. */
export function fc(filters: number, row: number, col: number): number {
  return (filters >>> ((((row << 1) & 14) | (col & 1)) << 1)) & 3;
}

/**
 * The 2×2 Bayer pattern [c00, c01, c10, c11] (0 = R, 1 = G, 2 = B) of a
 * LibRaw filters mask + cdesc, or null when the sensor is not a plain 2×2
 * Bayer (X-Trans = 9, Leaf = 1, 4-colour CMYG, patterns with row period > 2).
 */
export function bayerPattern(filters: number | undefined, cdesc: string | undefined): [number, number, number, number] | null {
  if (!filters || filters < 1000) return null;
  const desc = (cdesc || 'RGBG').toUpperCase();
  const map = (idx: number): number => {
    const ch = desc[idx];
    return ch === 'R' ? 0 : ch === 'G' ? 1 : ch === 'B' ? 2 : -1;
  };
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 2; c++) if (fc(filters, r, c) !== fc(filters, r + 2, c)) return null;
  }
  const p: [number, number, number, number] = [map(fc(filters, 0, 0)), map(fc(filters, 0, 1)), map(fc(filters, 1, 0)), map(fc(filters, 1, 1))];
  if (p.some((v) => v < 0)) return null;
  const counts = [0, 0, 0];
  for (const v of p) counts[v]++;
  return counts[0] === 1 && counts[1] === 2 && counts[2] === 1 ? p : null;
}

/* ------------------------------------------------------------------ */
/* White balance & matrices                                            */
/* ------------------------------------------------------------------ */

/**
 * As-shot multipliers (cam_mul, falling back to the daylight pre_mul),
 * normalized so the smallest is 1 — the dcraw convention that makes the
 * least-amplified channel clip exactly at the white level.
 */
export function wbMultipliers(camMul: number[] | undefined, preMul: number[] | undefined): [number, number, number] {
  const pick = (m: number[] | undefined): [number, number, number] | null => {
    if (!m || m.length < 3) return null;
    const g = m[1] > 0 ? m[1] : m[3] > 0 ? m[3] : 0;
    if (!(m[0] > 0 && g > 0 && m[2] > 0)) return null;
    return [m[0], g, m[2]];
  };
  const m = pick(camMul) ?? pick(preMul) ?? [1, 1, 1];
  const lo = Math.min(m[0], m[1], m[2]);
  return [m[0] / lo, m[1] / lo, m[2] / lo];
}

/**
 * Camera RGB → linear ProPhoto (row-major 3×3) from LibRaw's rgb_cam
 * (camera → linear sRGB, rows sum to 1). ProPhoto keeps the saturated
 * colours a camera records that sRGB would clip.
 */
export function camToProPhoto(rgbCam: number[][] | undefined): number[] {
  const valid =
    rgbCam && rgbCam.length >= 3 && rgbCam.every((r) => r.length >= 3 && r.every(Number.isFinite)) && rgbCam.some((r) => r.some((v) => v !== 0));
  const c = valid ? rgbCam! : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const p = MATRIX_SRGB_TO.prophoto;
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 3 + j] = p[i * 3] * c[0][j] + p[i * 3 + 1] * c[1][j] + p[i * 3 + 2] * c[2][j];
  }
  return out;
}

/** LibRaw/dcraw `flip` (0,1,2,3,4,5,6,7) → EXIF orientation (1..8). */
export function flipToOrientation(flip: number | undefined): number {
  switch (flip) {
    case 1:
      return 2;
    case 2:
      return 4;
    case 3:
      return 3;
    case 4:
      return 5;
    case 5:
      return 8;
    case 6:
      return 6;
    case 7:
      return 7;
    default:
      return 1;
  }
}
