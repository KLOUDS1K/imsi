/**
 * Helpers that turn compact, human-readable lens descriptions into
 * `LensProfile` coefficient tables.
 *
 * Vignetting is authored as "corner falloff in EV" at a focal length and
 * f-number, which is how lens reviews report it. It is converted to the
 * contract's polynomial gain g(r) = 1 + v1 r² + v2 r⁴ + v3 r⁶ (r = 1 at the
 * corner) by a least-squares fit of the natural falloff shape
 *   g(r) = 2^(EV · (0.45 r² + 0.55 r⁴))
 * (cos⁴-like near the centre, steeper towards the corners where mechanical
 * vignetting adds up). The same fitter is used by `resolve.ts` to scale
 * profiles and to fold in the manual vignetting slider.
 */
import type { LensProfile } from '../contracts';

export type DistRow = [focal: number, k1: number, k2: number, k3?: number];
export type VigRow = [focal: number, aperture: number, cornerEv: number];
export type CaRow = [focal: number, red: number, blue: number];

export interface LensSpec {
  id: string;
  make: string;
  model: string;
  mount?: string;
  /** Regex sources (case-insensitive) matched against meta.lens. */
  match: string[];
  focal: [min: number, max: number];
  dist: DistRow[];
  vig: VigRow[];
  ca: CaRow[];
  /**
   * Fixed-lens devices (phones, drones, action cams): regex sources matched
   * against "make model camera". `eq35` restricts the match to a range of
   * 35 mm-equivalent focal lengths (picks the right module of a multi-camera phone).
   */
  bodies?: string[];
  eq35?: [min: number, max: number];
  /** Generic fallback: tables are indexed by 35 mm-equivalent focal length. */
  generic?: boolean;
}

/** Internal profile shape: a LensProfile plus the device matching data. */
export interface LensProfileDef extends LensProfile {
  bodies?: string[];
  eq35?: [number, number];
  generic?: boolean;
}

/** Natural falloff shape in EV units (0 at the centre, 1 at the corner). */
export function falloffShape(r: number): number {
  const r2 = r * r;
  return 0.45 * r2 + 0.55 * r2 * r2;
}

/**
 * Weighted least-squares fit of g(r) ≈ 1 + v1 r² + v2 r⁴ + v3 r⁶ on r ∈ [0, 1].
 * Samples are weighted by r (image area grows with r) plus a floor so the
 * centre is not ignored, and the corner (r = 1) gets a heavy weight so the
 * corner value — what users notice — is reproduced almost exactly.
 */
export function fitGainPolynomial(target: (r: number) => number): [number, number, number] {
  const N = 48;
  // Normal equations A v = b for the 3 unknowns.
  const A = new Float64Array(9);
  const b = new Float64Array(3);
  for (let i = 0; i <= N; i++) {
    const r = i / N;
    const w = (i === N ? 12 : 0.15 + r) as number;
    const r2 = r * r;
    const x0 = r2;
    const x1 = r2 * r2;
    const x2 = x1 * r2;
    const y = target(r) - 1;
    const xs = [x0, x1, x2];
    for (let p = 0; p < 3; p++) {
      b[p] += w * xs[p] * y;
      for (let q = 0; q < 3; q++) A[p * 3 + q] += w * xs[p] * xs[q];
    }
  }
  const v = solve3(A, b);
  return [clean(v[0]), clean(v[1]), clean(v[2])];
}

const clean = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6);

/** Solve a 3×3 system by Cramer's rule (well conditioned for our basis on [0,1]). */
function solve3(A: Float64Array, b: Float64Array): [number, number, number] {
  const det = (m: ArrayLike<number>): number =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const d = det(A);
  if (Math.abs(d) < 1e-18) return [0, 0, 0];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const m = Array.from(A);
    for (let r = 0; r < 3; r++) m[r * 3 + c] = b[r];
    out[c] = det(m) / d;
  }
  return out;
}

/** Polynomial coefficients for a corner falloff of `ev` stops (negative = darker corners). */
export function vignetteFromEv(ev: number): [number, number, number] {
  if (ev === 0) return [0, 0, 0];
  return fitGainPolynomial((r) => Math.pow(2, ev * falloffShape(r)));
}

export function buildProfile(s: LensSpec): LensProfileDef {
  const p: LensProfileDef = {
    id: s.id,
    make: s.make,
    model: s.model,
    match: s.match,
    focalMin: s.focal[0],
    focalMax: s.focal[1],
    distortion: s.dist.map(([focal, k1, k2, k3]) => ({ focal, k1, k2, k3: k3 ?? 0 })),
    vignetting: s.vig.map(([focal, aperture, ev]) => {
      const [v1, v2, v3] = vignetteFromEv(ev);
      return { focal, aperture, v1, v2, v3 };
    }),
    ca: s.ca.map(([focal, red, blue]) => ({ focal, red, blue })),
    approximate: true,
  };
  if (s.mount) p.mount = s.mount;
  if (s.bodies) p.bodies = s.bodies;
  if (s.eq35) p.eq35 = s.eq35;
  if (s.generic) p.generic = true;
  return p;
}
