/**
 * Colour guided filter (He, Sun & Tang) used as edge-aware upsampling:
 * the linear coefficients are solved at the coarse work resolution and
 * bilinearly upsampled, then applied to the full-resolution guide
 * ("fast guided filter"), so coarse masks snap to the image's edges.
 */
import { boxBlur, resample } from './image';

export interface Guide {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

/**
 * Filter coarse mask `p` (low.w × low.h, 0..1) with guide `low`, apply the
 * resulting model to `high`. radius in low-res pixels; eps is the
 * regularization (smaller = follows edges more tightly).
 */
export function guidedUpsample(p: Float32Array, low: Guide, high: Guide, radius: number, eps: number): Float32Array {
  const { w, h } = low;
  const n = w * h;
  const bx = (a: Float32Array) => boxBlur(a, w, h, radius);
  const prod = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = a[i]! * b[i]!;
    return o;
  };
  const mr = bx(low.r), mg = bx(low.g), mb = bx(low.b), mp = bx(p);
  const rr = bx(prod(low.r, low.r)), rg = bx(prod(low.r, low.g)), rb = bx(prod(low.r, low.b));
  const gg = bx(prod(low.g, low.g)), gb = bx(prod(low.g, low.b)), bb = bx(prod(low.b, low.b));
  const rp = bx(prod(low.r, p)), gp = bx(prod(low.g, p)), bp = bx(prod(low.b, p));
  const ar = new Float32Array(n), ag = new Float32Array(n), ab = new Float32Array(n), b0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mR = mr[i]!, mG = mg[i]!, mB = mb[i]!, mP = mp[i]!;
    const s11 = rr[i]! - mR * mR + eps, s12 = rg[i]! - mR * mG, s13 = rb[i]! - mR * mB;
    const s22 = gg[i]! - mG * mG + eps, s23 = gb[i]! - mG * mB, s33 = bb[i]! - mB * mB + eps;
    const c1 = rp[i]! - mR * mP, c2 = gp[i]! - mG * mP, c3 = bp[i]! - mB * mP;
    // Inverse of the symmetric 3×3 covariance via cofactors.
    const i11 = s22 * s33 - s23 * s23, i12 = s13 * s23 - s12 * s33, i13 = s12 * s23 - s13 * s22;
    const i22 = s11 * s33 - s13 * s13, i23 = s13 * s12 - s11 * s23, i33 = s11 * s22 - s12 * s12;
    const det = s11 * i11 + s12 * i12 + s13 * i13;
    const k = Math.abs(det) > 1e-12 ? 1 / det : 0;
    const a1 = (i11 * c1 + i12 * c2 + i13 * c3) * k;
    const a2 = (i12 * c1 + i22 * c2 + i23 * c3) * k;
    const a3 = (i13 * c1 + i23 * c2 + i33 * c3) * k;
    ar[i] = a1;
    ag[i] = a2;
    ab[i] = a3;
    b0[i] = mP - a1 * mR - a2 * mG - a3 * mB;
  }
  let Ar = bx(ar), Ag = bx(ag), Ab = bx(ab), Bb = bx(b0);
  const H = high;
  if (H.w !== w || H.h !== h) {
    Ar = resample(Ar, w, h, H.w, H.h);
    Ag = resample(Ag, w, h, H.w, H.h);
    Ab = resample(Ab, w, h, H.w, H.h);
    Bb = resample(Bb, w, h, H.w, H.h);
  }
  const N = H.w * H.h;
  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Ar[i]! * H.r[i]! + Ag[i]! * H.g[i]! + Ab[i]! * H.b[i]! + Bb[i]!;
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/** Contrast curve that crisps a guided-filter output while keeping a soft 1–2 px edge. */
export function crisp(q: Float32Array, lo = 0.25, hi = 0.75): Float32Array {
  const k = 1 / (hi - lo);
  for (let i = 0; i < q.length; i++) {
    const t = Math.max(0, Math.min(1, (q[i]! - lo) * k));
    q[i] = t * t * (3 - 2 * t);
  }
  return q;
}
