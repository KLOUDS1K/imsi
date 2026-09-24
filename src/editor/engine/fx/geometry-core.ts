/**
 * Pure geometry math shared by the CPU mirror (`engine/geometry.ts`) and the
 * GPU geometry pass (`fx/geometry-pass.ts`). Nothing here touches the lens
 * profile database: callers hand in an already-resolved `LensCorrection`, so
 * this file has no dependency on `@/editor/lens`.
 *
 * Spaces (ARCHITECTURE.md "Coordinate spaces"), all normalized 0..1 with
 * (0,0) = top-left, y down:
 *
 *   S source ──lens──▶ L lens-corrected ──orient/flip──▶ O oriented
 *     ──straighten+transform──▶ F frame ──crop──▶ output
 *
 * Every step from L to the output is projective (orientation, flips and the
 * crop are affine; keystone is a homography), so the whole chain
 * output → L collapses into ONE 3×3 homogeneous matrix. Only the radial lens
 * model L → S is non-linear. The shader receives exactly the matrix and the
 * coefficients computed here (see `buildGeometryUniforms`), so the CPU and GPU
 * agree to float precision.
 *
 * Lens model (Brown–Conrady, "correction to remove"): for a lens-corrected
 * point at radius r (normalized to the source half-diagonal) the source pixel
 * lies at radius r·g(r), g(r) = 1 + k1 r² + k2 r⁴ + k3 r⁶, same direction.
 * Positive `lens.distortion` produces k1 < 0, which removes barrel distortion.
 * Lateral CA: the red (blue) channel is sampled at the green source position
 * scaled radially about the centre by caRed (caBlue); 1 = no correction.
 */
import type { LensCorrection } from '../../contracts';
import type { EditParams, Point, Rect } from '../../types';
import type { PassContext, UniformMap } from '../pass-types';

/** Row-major 3×3 matrix. */
export type Mat3 = Float64Array;

/** The subset of LensCorrection geometry needs (distortion + lateral CA). */
export interface LensTerms {
  k1: number;
  k2: number;
  k3: number;
  caRed: number;
  caBlue: number;
}

export const NO_LENS: Readonly<LensTerms> = Object.freeze({ k1: 0, k2: 0, k3: 0, caRed: 1, caBlue: 1 });

/** Keystone strength per slider unit (ARCHITECTURE "Sign conventions"). */
export const KEYSTONE_PER_UNIT = 0.4 / 100;

const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Distortion + CA terms of a resolved lens correction, CA gated by `params.lens.removeCA`. */
export function lensTermsFrom(params: EditParams, lens: LensCorrection | null | undefined): LensTerms {
  if (!lens) return NO_LENS;
  const ca = params.lens.removeCA;
  return {
    k1: fin(lens.k1, 0),
    k2: fin(lens.k2, 0),
    k3: fin(lens.k3, 0),
    caRed: ca ? fin(lens.caRed, 1) : 1,
    caBlue: ca ? fin(lens.caBlue, 1) : 1,
  };
}

/* ------------------------------------------------------------------ */
/* 3×3 matrix helpers (row-major, float64)                             */
/* ------------------------------------------------------------------ */

export function mat3(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): Mat3 {
  const m = new Float64Array(9);
  m[0] = a; m[1] = b; m[2] = c;
  m[3] = d; m[4] = e; m[5] = f;
  m[6] = g; m[7] = h; m[8] = i;
  return m;
}

export const identity3 = (): Mat3 => mat3(1, 0, 0, 0, 1, 0, 0, 0, 1);

/** a · b (apply b first, then a). */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const m = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return m;
}

/** Product of a chain, applied right-to-left: chain(A, B, C) = A·B·C. */
export function chain3(...ms: Mat3[]): Mat3 {
  let acc = ms[ms.length - 1];
  for (let i = ms.length - 2; i >= 0; i--) acc = mul3(ms[i], acc);
  return acc;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) throw new Error('geometry: singular matrix');
  const s = 1 / det;
  return mat3(
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  );
}

/** Projective apply; returns false when the point maps to/behind the horizon (w ≤ 0). */
export function applyH(m: Mat3, x: number, y: number, out: Point): boolean {
  const w = m[6] * x + m[7] * y + m[8];
  if (!(w > 1e-12)) {
    out.x = NaN;
    out.y = NaN;
    return false;
  }
  out.x = (m[0] * x + m[1] * y + m[2]) / w;
  out.y = (m[3] * x + m[4] * y + m[5]) / w;
  return true;
}

/* ------------------------------------------------------------------ */
/* Parameter sanitation                                                */
/* ------------------------------------------------------------------ */

export type Orientation = 0 | 90 | 180 | 270;

export function normOrientation(o: number): Orientation {
  const q = ((Math.round(fin(o, 0) / 90) % 4) + 4) % 4;
  return (q * 90) as Orientation;
}

/** Crop rect with finite, strictly positive size. */
export function sanitizeCrop(c: EditParams['crop']): Rect {
  const w = Math.max(1e-6, fin(c.w, 1));
  const h = Math.max(1e-6, fin(c.h, 1));
  return { x: fin(c.x, 0), y: fin(c.y, 0), w, h };
}

/* ------------------------------------------------------------------ */
/* Sizes                                                               */
/* ------------------------------------------------------------------ */

/**
 * Frame size = the oriented image size (Lightroom-style: straighten/transform
 * keep the canvas size; `maxValidCrop` handles the invalid corners).
 */
export function frameSizeOf(params: EditParams, srcW: number, srcH: number): { width: number; height: number } {
  const o = normOrientation(params.crop.orientation);
  const w = Math.max(1, srcW);
  const h = Math.max(1, srcH);
  return o === 90 || o === 270 ? { width: h, height: w } : { width: w, height: h };
}

export function outputSizeOf(params: EditParams, srcW: number, srcH: number): { width: number; height: number } {
  const f = frameSizeOf(params, srcW, srcH);
  const c = sanitizeCrop(params.crop);
  return {
    width: Math.max(1, Math.round(f.width * Math.min(1, c.w))),
    height: Math.max(1, Math.round(f.height * Math.min(1, c.h))),
  };
}

/** Numeric aspect (w/h) of `params.crop.aspect`; literal ratios, 'original' = frame aspect, null = free. */
export function aspectRatioOf(params: EditParams, srcW: number, srcH: number): number | null {
  switch (params.crop.aspect) {
    case 'free':
      return null;
    case 'original': {
      const f = frameSizeOf(params, srcW, srcH);
      return f.width / f.height;
    }
    case '1:1':
      return 1;
    case '3:2':
      return 3 / 2;
    case '4:3':
      return 4 / 3;
    case '5:4':
      return 5 / 4;
    case '16:9':
      return 16 / 9;
    case '4:5':
      return 4 / 5;
    case '2:3':
      return 2 / 3;
    case 'custom': {
      const [a, b] = params.crop.customAspect;
      return a > 0 && b > 0 && Number.isFinite(a / b) ? a / b : null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Matrices of the individual steps                                    */
/* ------------------------------------------------------------------ */

/** L (lens-corrected, normalized) → O (oriented, normalized): clockwise quarter turns, then flips. */
export function orientationMatrix(params: EditParams): Mat3 {
  let rot: Mat3;
  switch (normOrientation(params.crop.orientation)) {
    case 90: // top-left → top-right: (u,v) → (1−v, u)
      rot = mat3(0, -1, 1, 1, 0, 0, 0, 0, 1);
      break;
    case 180:
      rot = mat3(-1, 0, 1, 0, -1, 1, 0, 0, 1);
      break;
    case 270: // (u,v) → (v, 1−u)
      rot = mat3(0, 1, 0, -1, 0, 1, 0, 0, 1);
      break;
    default:
      rot = identity3();
  }
  const fh = params.crop.flipH ? mat3(-1, 0, 1, 0, 1, 0, 0, 0, 1) : identity3();
  const fv = params.crop.flipV ? mat3(1, 0, 0, 0, -1, 1, 0, 0, 1) : identity3();
  return chain3(fv, fh, rot);
}

/**
 * Keystone homography in "half-size" coordinates (n ∈ [-1,1]², centre = 0).
 * Vertical k: maps the top edge (y=-1) to width (1+k) and the bottom edge to
 * (1-k) while keeping both edges on their rows:
 *   X = (1-k²)·x / (1+k·y),  Y = (y+k) / (1+k·y)
 * Horizontal k (right edge height ×(1+k), left ×(1-k)):
 *   X = (x-k) / (1-k·x),     Y = (1-k²)·y / (1-k·x)
 * Vertical is applied first.
 */
export function keystoneMatrix(vertical: number, horizontal: number): Mat3 {
  const kv = clampK(fin(vertical, 0) * KEYSTONE_PER_UNIT);
  const kh = clampK(fin(horizontal, 0) * KEYSTONE_PER_UNIT);
  const hv = mat3(1 - kv * kv, 0, 0, 0, 1, kv, 0, kv, 1);
  const hh = mat3(1, 0, -kh, 0, 1 - kh * kh, 0, -kh, 0, 1);
  return mul3(hh, hv);
}

const clampK = (k: number) => Math.max(-0.95, Math.min(0.95, k));

/**
 * O → F, the forward content transform about the image centre, in this order:
 * keystone → aspect → rotate (crop.angle + transform.rotate, clockwise on
 * screen) → uniform scale → offsets (in frame axes).
 */
export function frameTransformMatrix(params: EditParams, frameW: number, frameH: number): Mat3 {
  const t = params.transform;
  const W = frameW;
  const H = frameH;
  const toHalf = mat3(2, 0, -1, 0, 2, -1, 0, 0, 1);
  const K = keystoneMatrix(t.vertical, t.horizontal);
  const toPx = mat3(W / 2, 0, 0, 0, H / 2, 0, 0, 0, 1);
  const a = Math.pow(2, (fin(t.aspect, 0) / 100) * 0.5);
  const asp = mat3(a, 0, 0, 0, 1 / a, 0, 0, 0, 1);
  const theta = ((fin(params.crop.angle, 0) + fin(t.rotate, 0)) * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // y-down screen: this standard matrix turns +x towards +y, i.e. clockwise.
  const rot = mat3(c, -s, 0, s, c, 0, 0, 0, 1);
  const sc = Math.max(1e-3, fin(t.scale, 100) / 100);
  const scale = mat3(sc, 0, 0, 0, sc, 0, 0, 0, 1);
  const off = mat3(1, 0, (fin(t.offsetX, 0) / 100) * 0.5 * W, 0, 1, (fin(t.offsetY, 0) / 100) * 0.5 * H, 0, 0, 1);
  const toFrame = mat3(1 / W, 0, 0.5, 0, 1 / H, 0.5, 0, 0, 1);
  return chain3(toFrame, off, scale, rot, asp, toPx, K, toHalf);
}

/** output-normalized → frame-normalized. */
export function cropMatrix(params: EditParams, ignoreCrop: boolean): Mat3 {
  if (ignoreCrop) return identity3();
  const c = sanitizeCrop(params.crop);
  return mat3(c.w, 0, c.x, 0, c.h, c.y, 0, 0, 1);
}

/* ------------------------------------------------------------------ */
/* Plan: everything needed to map points, computed once per call        */
/* ------------------------------------------------------------------ */

export interface GeometryPlan {
  srcW: number;
  srcH: number;
  frameW: number;
  frameH: number;
  /** output-normalized (frame-normalized when ignoreCrop) → L-normalized. */
  outToLens: Mat3;
  /** Inverse of outToLens. */
  lensToOut: Mat3;
  lens: LensTerms;
  /** (W, H) / half-diagonal: converts normalized offsets from the centre into half-diagonal units. */
  axisX: number;
  axisY: number;
  hasDistortion: boolean;
}

export function createGeometryPlan(
  params: EditParams,
  srcW: number,
  srcH: number,
  ignoreCrop: boolean,
  lens: LensTerms = NO_LENS,
): GeometryPlan {
  const W = Math.max(1, srcW);
  const H = Math.max(1, srcH);
  const f = frameSizeOf(params, W, H);
  const orient = orientationMatrix(params);
  const fwd = frameTransformMatrix(params, f.width, f.height);
  const outToFrame = cropMatrix(params, ignoreCrop);
  // out → F → O → L
  const outToLens = chain3(inv3(orient), inv3(fwd), outToFrame);
  const halfDiag = 0.5 * Math.hypot(W, H);
  return {
    srcW: W,
    srcH: H,
    frameW: f.width,
    frameH: f.height,
    outToLens,
    lensToOut: inv3(outToLens),
    lens,
    axisX: W / halfDiag,
    axisY: H / halfDiag,
    hasDistortion: lens.k1 !== 0 || lens.k2 !== 0 || lens.k3 !== 0,
  };
}

/**
 * L → S (green channel). Returns false when the radial model folds over
 * (d(r·g)/dr ≤ 0) — the shader treats those pixels as outside the image.
 */
export function lensForward(plan: GeometryPlan, lx: number, ly: number, out: Point): boolean {
  const dx = lx - 0.5;
  const dy = ly - 0.5;
  const { k1, k2, k3 } = plan.lens;
  const ex = dx * plan.axisX;
  const ey = dy * plan.axisY;
  const r2 = ex * ex + ey * ey;
  const g = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  const slope = 1 + r2 * (3 * k1 + r2 * (5 * k2 + r2 * 7 * k3));
  out.x = 0.5 + dx * g;
  out.y = 0.5 + dy * g;
  return slope > 0;
}

/** f(r) = r·g(r) */
const radial = (r: number, k1: number, k2: number, k3: number) => {
  const r2 = r * r;
  return r * (1 + r2 * (k1 + r2 * (k2 + r2 * k3)));
};
const radialSlope = (r: number, k1: number, k2: number, k3: number) => {
  const r2 = r * r;
  return 1 + r2 * (3 * k1 + r2 * (5 * k2 + r2 * 7 * k3));
};

/**
 * Solve r·g(r) = rs for the corrected radius r on the monotone branch that
 * starts at 0. Newton from r = rs (quadratic convergence for realistic
 * coefficients), falling back to bisection inside the monotone bracket.
 * Returns NaN when rs is beyond the fold (not reachable).
 */
export function undistortRadius(rs: number, k1: number, k2: number, k3: number): number {
  if (!(rs > 0)) return 0;
  if (k1 === 0 && k2 === 0 && k3 === 0) return rs;
  let r = rs;
  for (let i = 0; i < 40; i++) {
    const f = radial(r, k1, k2, k3) - rs;
    const df = radialSlope(r, k1, k2, k3);
    if (!(df > 1e-9)) break;
    const next = r - f / df;
    if (!(next > 0) || !Number.isFinite(next)) break;
    if (Math.abs(next - r) <= 1e-15 * (1 + r)) return next;
    r = next;
    if (i === 39 && Math.abs(f) < 1e-12) return r;
  }
  // Bisection on [0, hi] where hi stays on the monotone branch.
  let hi = 0;
  let step = Math.max(rs, 1e-3);
  while (hi < 64) {
    const cand = hi + step;
    if (radialSlope(cand, k1, k2, k3) <= 0) {
      if (step < 1e-9) break;
      step *= 0.5;
      continue;
    }
    hi = cand;
    if (radial(hi, k1, k2, k3) >= rs) break;
    step *= 2;
  }
  if (!(radial(hi, k1, k2, k3) >= rs)) return NaN;
  let lo = 0;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (radial(mid, k1, k2, k3) < rs) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** S → L. Returns false when the source point is beyond the lens model's fold. */
export function lensInverse(plan: GeometryPlan, sx: number, sy: number, out: Point): boolean {
  if (!plan.hasDistortion) {
    out.x = sx;
    out.y = sy;
    return true;
  }
  const dx = sx - 0.5;
  const dy = sy - 0.5;
  const ex = dx * plan.axisX;
  const ey = dy * plan.axisY;
  const rs = Math.hypot(ex, ey);
  if (rs === 0) {
    out.x = 0.5;
    out.y = 0.5;
    return true;
  }
  const r = undistortRadius(rs, plan.lens.k1, plan.lens.k2, plan.lens.k3);
  if (!Number.isFinite(r)) {
    out.x = NaN;
    out.y = NaN;
    return false;
  }
  const s = r / rs;
  out.x = 0.5 + dx * s;
  out.y = 0.5 + dy * s;
  return true;
}

const tmpL: Point = { x: 0, y: 0 };

/** output (or frame) normalized → source normalized. Returns validity of the mapping (not bounds). */
export function mapOutToSource(plan: GeometryPlan, u: number, v: number, out: Point): boolean {
  if (!applyH(plan.outToLens, u, v, tmpL)) {
    out.x = NaN;
    out.y = NaN;
    return false;
  }
  return lensForward(plan, tmpL.x, tmpL.y, out);
}

/** source normalized → output (or frame) normalized. */
export function mapSourceToOut(plan: GeometryPlan, x: number, y: number, out: Point): boolean {
  if (!lensInverse(plan, x, y, tmpL)) {
    out.x = NaN;
    out.y = NaN;
    return false;
  }
  return applyH(plan.lensToOut, tmpL.x, tmpL.y, out);
}

/* ------------------------------------------------------------------ */
/* Shader uniforms                                                     */
/* ------------------------------------------------------------------ */

export type GeometryUniformContext = Pick<PassContext, 'srcWidth' | 'srcHeight' | 'ignoreCrop' | 'outRect' | 'lens' | 'quality'>;

export interface GeometryUniforms extends UniformMap {
  /** Rows of the vUv → L homography (vUv is the rendered texture's 0..1 coords; outRect folded in). */
  uGeoRow0: number[];
  uGeoRow1: number[];
  uGeoRow2: number[];
  /** Brown–Conrady k1, k2, k3. */
  uLensK: number[];
  /** (W, H) / half-diagonal of the source. */
  uLensAxis: number[];
  /** Lateral CA radial scales (red, blue). */
  uCA: number[];
  /** 1 when CA correction differs from identity. */
  uUseCA: number;
  /** 1 = Catmull-Rom (full quality), 0 = bilinear (draft). */
  uBicubic: number;
  /** 0 = warp uInput; 1 = warp the R channel of uOverlay. */
  uOverlayMode: number;
}

/**
 * Pure function shared by the geometry shader and tests: the exact numbers
 * the GPU uses. `ctx.outRect` (normalized sub-rectangle of the output) is
 * folded into the matrix, so vUv of the rendered tile maps straight to L.
 */
export function buildGeometryUniforms(params: EditParams, ctx: GeometryUniformContext): GeometryUniforms {
  const lens = lensTermsFrom(params, ctx.lens);
  const plan = createGeometryPlan(params, ctx.srcWidth, ctx.srcHeight, ctx.ignoreCrop, lens);
  const r = ctx.outRect ?? { x: 0, y: 0, w: 1, h: 1 };
  const tile = mat3(fin(r.w, 1), 0, fin(r.x, 0), 0, fin(r.h, 1), fin(r.y, 0), 0, 0, 1);
  const m = mul3(plan.outToLens, tile);
  // Normalize so the homogeneous row has a sane magnitude (helps float32).
  const n = Math.abs(m[8]) > 1e-12 ? m[8] : 1;
  const useCA = Math.abs(lens.caRed - 1) > 1e-7 || Math.abs(lens.caBlue - 1) > 1e-7;
  return {
    uGeoRow0: [m[0] / n, m[1] / n, m[2] / n],
    uGeoRow1: [m[3] / n, m[4] / n, m[5] / n],
    uGeoRow2: [m[6] / n, m[7] / n, m[8] / n],
    uLensK: [lens.k1, lens.k2, lens.k3],
    uLensAxis: [plan.axisX, plan.axisY],
    uCA: [lens.caRed, lens.caBlue],
    uUseCA: useCA ? 1 : 0,
    uBicubic: ctx.quality === 'full' ? 1 : 0,
    uOverlayMode: 0,
  };
}

/** True when the uniforms describe an exact identity copy (no warp, no lens, full tile). */
export function isGeometryIdentity(u: GeometryUniforms): boolean {
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rows = [...u.uGeoRow0, ...u.uGeoRow1, ...u.uGeoRow2];
  for (let i = 0; i < 9; i++) if (Math.abs(rows[i] - id[i]) > 1e-12) return false;
  return u.uLensK[0] === 0 && u.uLensK[1] === 0 && u.uLensK[2] === 0 && u.uUseCA === 0;
}
