/**
 * Lens profiles: detection from metadata and conversion of the Optics
 * settings into shader-ready correction terms (see contracts.LensModule).
 *
 * Manual lens vignetting (params.lens.vignetting) is applied by the color PRE
 * pass itself, so it is NOT folded into v1..v3 here. Manual distortion IS
 * folded into k1 (ARCHITECTURE.md: k1 += -0.15 · d / 100).
 */
import type { LensCorrection, LensModule, LensProfile } from '../contracts';
import type { EditParams, PhotoMeta } from '../types';
import { vignetteFromEv, type LensProfileDef } from './build';
import { GENERIC_DEFS, PROFILE_DEFS } from './profiles';

export const LENS_PROFILES: LensProfile[] = [...PROFILE_DEFS, ...GENERIC_DEFS];

export function getLensProfile(id: string): LensProfile | null {
  return LENS_PROFILES.find((p) => p.id === id) ?? null;
}

const rx = (src: string) => {
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
};

function eq35(meta: PhotoMeta): number | undefined {
  return meta.focalLength35 ?? meta.focalLength;
}

export function detectLensProfile(meta: PhotoMeta): LensProfile | null {
  const lens = meta.lens ?? '';
  if (lens) {
    for (const p of PROFILE_DEFS) if (p.match.some((m) => rx(m)?.test(lens))) return p;
  }
  const body = `${meta.make ?? ''} ${meta.model ?? ''} ${meta.camera ?? ''}`;
  const f35 = eq35(meta);
  for (const p of PROFILE_DEFS) {
    if (!p.bodies?.some((b) => rx(b)?.test(body))) continue;
    if (p.eq35 && f35 !== undefined && (f35 < p.eq35[0] || f35 > p.eq35[1])) continue;
    return p;
  }
  return f35 !== undefined ? GENERIC_DEFS[0] : null;
}

/** Linear interpolation of table rows by focal length (clamped at the ends). */
function interp<T extends { focal: number }>(rows: T[], focal: number, pick: (r: T) => number[]): number[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.focal - b.focal);
  if (focal <= sorted[0].focal) return pick(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (focal >= last.focal) return pick(last);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (focal >= a.focal && focal <= b.focal) {
      const t = (focal - a.focal) / (b.focal - a.focal || 1);
      const va = pick(a);
      const vb = pick(b);
      return va.map((v, k) => v + (vb[k] - v) * t);
    }
  }
  return pick(last);
}

/** Corner falloff (EV) of the profile at this focal length / aperture. */
function cornerEv(p: LensProfile, focal: number, aperture: number | undefined): number {
  // Recover EV from the fitted polynomial at r = 1: g(1) = 1 + v1 + v2 + v3.
  const [v1, v2, v3, n0] = interp(p.vignetting, focal, (r) => [r.v1, r.v2, r.v3, r.aperture]);
  if (v1 === undefined) return 0;
  const g = Math.max(1e-3, 1 + v1 + v2 + v3);
  let ev = Math.log2(g);
  // Stopping down reduces vignetting: roughly a third of it per stop, gone after ~3 stops.
  if (aperture && n0 && aperture > n0) ev *= Math.max(0, 1 - 0.33 * Math.log2(aperture / n0));
  return ev;
}

const cache = new Map<string, LensCorrection>();

export function resolveLensCorrection(lens: EditParams['lens'], meta: PhotoMeta): LensCorrection {
  const key = JSON.stringify([lens, meta.lens, meta.make, meta.model, meta.focalLength, meta.focalLength35, meta.aperture]);
  const hit = cache.get(key);
  if (hit) return hit;

  const detected = lens.profileId ? getLensProfile(lens.profileId) : detectLensProfile(meta);
  const profile = lens.profileEnabled ? detected : null;
  const def = detected as LensProfileDef | null;
  const focalFor = (p: LensProfile | null) => {
    if (!p) return 0;
    const f = (p as LensProfileDef).generic ? eq35(meta) : meta.focalLength;
    return f ?? (p.focalMin + p.focalMax) / 2;
  };

  let k1 = 0;
  let k2 = 0;
  let k3 = 0;
  let v1 = 0;
  let v2 = 0;
  let v3 = 0;
  if (profile) {
    const f = focalFor(profile);
    const ds = lens.profileDistortionScale / 100;
    const [a, b, c] = interp(profile.distortion, f, (r) => [r.k1, r.k2, r.k3]);
    k1 = (a ?? 0) * ds;
    k2 = (b ?? 0) * ds;
    k3 = (c ?? 0) * ds;
    const ev = cornerEv(profile, f, meta.aperture) * (lens.profileVignettingScale / 100);
    [v1, v2, v3] = vignetteFromEv(ev);
  }
  k1 += -0.15 * (lens.distortion / 100);

  let caRed = 1;
  let caBlue = 1;
  if (lens.removeCA) {
    const src = def ?? GENERIC_DEFS[0];
    const [r, b] = interp(src.ca, focalFor(src) || 35, (row) => [row.red, row.blue]);
    caRed = r ?? 1;
    caBlue = b ?? 1;
  }

  const out: LensCorrection = { profile, k1, k2, k3, v1, v2, v3, caRed, caBlue };
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

export const lensModule = {
  LENS_PROFILES,
  getLensProfile,
  detectLensProfile,
  resolveLensCorrection,
} satisfies LensModule;
