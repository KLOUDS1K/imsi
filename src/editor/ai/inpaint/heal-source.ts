/**
 * Content-aware heal source search and dust → heal-spot conversion.
 *
 * findHealSource compares candidate source centres on concentric rings around
 * the spot. The destination's interior is the blemish, so it cannot be used;
 * instead each candidate is scored by
 *   - SSD between the candidate's surrounding annulus and the destination's
 *     annulus (half raw, half with the mean colour removed, because the heal
 *     blend matches low frequencies anyway),
 *   - texture similarity: the candidate interior's luminance std versus the
 *     destination annulus's std (copying a flat patch into grain looks
 *     smudged, and vice versa),
 *   - an outlier term: the candidate interior should look like its own
 *     surroundings (avoids copying another blemish or an edge),
 *   - a tiny distance preference (closer = more likely same lighting).
 * The work happens on a small window around the spot, resampled so the spot
 * radius is ~10 px, so the cost is independent of the image size.
 */
import type { HealSpot, PixelBuffer, Point } from '@/editor/types';
import { createFloatReader } from './pixels';

/** Work-scale spot radius in pixels. */
const WORK_RADIUS = 10;
/** Candidate rings, as multiples of the radius (the first keeps the discs from overlapping). */
const RINGS = [2.1, 2.8, 3.6, 4.5, 5.5, 6.6];
const MIN_DIST = 2.0;
const ANNULUS_OUTER = 1.7;

interface Window {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** work-scale / source-scale */
  s: number;
  rgb: Float32Array;
  lum: Float32Array;
}

/** Area-averaged, sRGB-encoded RGB copy of a source window at scale s (≤ 1). */
function readWindow(px: PixelBuffer, sx0: number, sy0: number, sx1: number, sy1: number, s: number): Window {
  const w = Math.max(1, Math.ceil((sx1 - sx0) * s));
  const h = Math.max(1, Math.ceil((sy1 - sy0) * s));
  const rgb = new Float32Array(w * h * 3);
  const cnt = new Float32Array(w * h);
  const read = createFloatReader(px);
  const tmp = new Float32Array(3);
  const W = px.width;
  for (let y = sy0; y < sy1; y++) {
    const wy = Math.min(h - 1, Math.floor((y - sy0) * s));
    for (let x = sx0; x < sx1; x++) {
      const wx = Math.min(w - 1, Math.floor((x - sx0) * s));
      read((y * W + x) * 4, tmp);
      const o = wy * w + wx;
      rgb[o * 3] += tmp[0];
      rgb[o * 3 + 1] += tmp[1];
      rgb[o * 3 + 2] += tmp[2];
      cnt[o]++;
    }
  }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const n = cnt[i] || 1;
    rgb[i * 3] /= n;
    rgb[i * 3 + 1] /= n;
    rgb[i * 3 + 2] /= n;
    lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }
  return { x0: sx0, y0: sy0, w, h, s, rgb, lum };
}

function offsets(rIn: number, rOut: number): Int32Array {
  const out: number[] = [];
  const R = Math.ceil(rOut);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d >= rIn && d <= rOut) out.push(dx, dy);
    }
  }
  return Int32Array.from(out);
}

interface RegionStats {
  n: number;
  mean: [number, number, number];
  lumStd: number;
}

function regionStats(win: Window, cx: number, cy: number, offs: Int32Array): RegionStats {
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let l = 0;
  let l2 = 0;
  for (let k = 0; k < offs.length; k += 2) {
    const x = cx + offs[k];
    const y = cy + offs[k + 1];
    if (x < 0 || y < 0 || x >= win.w || y >= win.h) continue;
    const i = y * win.w + x;
    r += win.rgb[i * 3];
    g += win.rgb[i * 3 + 1];
    b += win.rgb[i * 3 + 2];
    l += win.lum[i];
    l2 += win.lum[i] * win.lum[i];
    n++;
  }
  if (!n) return { n: 0, mean: [0, 0, 0], lumStd: 0 };
  const ml = l / n;
  return { n, mean: [r / n, g / n, b / n], lumStd: Math.sqrt(Math.max(l2 / n - ml * ml, 0)) };
}

/**
 * Best source centre for a content-aware spot. In/out coordinates are
 * source-normalized; `radius` is a fraction of the long edge.
 */
export function findHealSource(px: PixelBuffer, spot: Pick<HealSpot, 'x' | 'y' | 'radius'>): Point {
  const W = px.width;
  const H = px.height;
  const long = Math.max(W, H);
  const rPx = Math.max(spot.radius * long, 0.5);
  const s = Math.min(1, WORK_RADIUS / rPx);
  const reach = (RINGS[RINGS.length - 1] + ANNULUS_OUTER + 0.6) * rPx;
  const X = spot.x * W;
  const Y = spot.y * H;
  const sx0 = Math.max(0, Math.floor(X - reach));
  const sy0 = Math.max(0, Math.floor(Y - reach));
  const sx1 = Math.min(W, Math.ceil(X + reach));
  const sy1 = Math.min(H, Math.ceil(Y + reach));
  const fallback = fallbackSource(spot, rPx, W, H);
  if (sx1 - sx0 < 2 || sy1 - sy0 < 2) return fallback;

  const win = readWindow(px, sx0, sy0, sx1, sy1, s);
  const r = Math.max(rPx * s, 1);
  const inner = offsets(0, r);
  const ann = offsets(r * 1.05, Math.max(r * ANNULUS_OUTER, r + 1.5));
  const dcx = Math.round((X - sx0) * s - 0.5);
  const dcy = Math.round((Y - sy0) * s - 0.5);

  // Destination annulus values (NaN = outside the window).
  const annN = ann.length / 2;
  const dAnn = new Float32Array(annN * 3);
  const dOk = new Uint8Array(annN);
  for (let k = 0; k < annN; k++) {
    const x = dcx + ann[k * 2];
    const y = dcy + ann[k * 2 + 1];
    if (x < 0 || y < 0 || x >= win.w || y >= win.h) continue;
    const i = y * win.w + x;
    dAnn[k * 3] = win.rgb[i * 3];
    dAnn[k * 3 + 1] = win.rgb[i * 3 + 1];
    dAnn[k * 3 + 2] = win.rgb[i * 3 + 2];
    dOk[k] = 1;
  }
  const dStats = regionStats(win, dcx, dcy, ann);
  if (dStats.n === 0) return fallback;

  // Candidate centres must keep their whole disc inside the image.
  const minX = Math.ceil(r);
  const minY = Math.ceil(r);
  const maxX = win.w - 1 - Math.ceil(r);
  const maxY = win.h - 1 - Math.ceil(r);
  const inImage = (cx: number, cy: number) => {
    const gx = sx0 + (cx + 0.5) / s;
    const gy = sy0 + (cy + 0.5) / s;
    return gx - rPx >= 0 && gy - rPx >= 0 && gx + rPx <= W && gy + rPx <= H && cx >= minX && cy >= minY && cx <= maxX && cy <= maxY;
  };

  const score = (cx: number, cy: number): number => {
    let ssd = 0;
    let n = 0;
    let dr = 0;
    let dg = 0;
    let db = 0;
    for (let k = 0; k < annN; k++) {
      if (!dOk[k]) continue;
      const x = cx + ann[k * 2];
      const y = cy + ann[k * 2 + 1];
      if (x < 0 || y < 0 || x >= win.w || y >= win.h) continue;
      const i = (y * win.w + x) * 3;
      const er = win.rgb[i] - dAnn[k * 3];
      const eg = win.rgb[i + 1] - dAnn[k * 3 + 1];
      const eb = win.rgb[i + 2] - dAnn[k * 3 + 2];
      ssd += er * er + eg * eg + eb * eb;
      dr += er;
      dg += eg;
      db += eb;
      n++;
    }
    if (n < annN * 0.4) return Infinity;
    const raw = ssd / n;
    const meanRemoved = raw - (dr * dr + dg * dg + db * db) / (n * n);
    const cIn = regionStats(win, cx, cy, inner);
    const cAnn = regionStats(win, cx, cy, ann);
    const tex = cIn.lumStd - dStats.lumStd;
    const om = cIn.mean.map((v, c) => v - cAnn.mean[c]);
    const outlier = om[0] * om[0] + om[1] * om[1] + om[2] * om[2] + Math.max(0, cIn.lumStd - cAnn.lumStd) ** 2;
    const dist = Math.hypot(cx - dcx, cy - dcy) / r;
    return 0.5 * raw + 0.5 * Math.max(meanRemoved, 0) + 2 * tex * tex + 0.5 * outlier + 2e-4 * dist;
  };

  let best = Infinity;
  let bx = -1;
  let by = -1;
  for (const k of RINGS) {
    const d = k * r;
    const count = Math.max(8, Math.round((2 * Math.PI * k) / 0.5));
    for (let a = 0; a < count; a++) {
      const t = (a / count) * 2 * Math.PI + k; // ring-dependent phase decorrelates the rings
      const cx = Math.round(dcx + d * Math.cos(t));
      const cy = Math.round(dcy + d * Math.sin(t));
      if (!inImage(cx, cy)) continue;
      const sc = score(cx, cy);
      if (sc < best) {
        best = sc;
        bx = cx;
        by = cy;
      }
    }
  }
  if (bx < 0) return fallback;

  // Local refinement on a shrinking grid, keeping the minimum distance.
  for (let step = Math.max(1, Math.round(r / 2)); step >= 1; step = step > 1 ? Math.floor(step / 2) : 0) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const cx = bx + ox * step;
          const cy = by + oy * step;
          if (!inImage(cx, cy) || Math.hypot(cx - dcx, cy - dcy) < MIN_DIST * r) continue;
          const sc = score(cx, cy);
          if (sc < best - 1e-9) {
            best = sc;
            bx = cx;
            by = cy;
            improved = true;
          }
        }
      }
    }
    if (step === 1) break;
  }
  return { x: (sx0 + (bx + 0.5) / s) / W, y: (sy0 + (by + 0.5) / s) / H };
}

/** A source 2.5 radii away, towards the image centre (used when the search finds nothing). */
function fallbackSource(spot: Pick<HealSpot, 'x' | 'y'>, rPx: number, W: number, H: number): Point {
  const dx = spot.x < 0.5 ? 1 : -1;
  const x = Math.min(Math.max(spot.x * W + dx * 2.5 * rPx, rPx), W - rPx);
  return { x: x / W, y: spot.y };
}

/** Dust candidates → heal spots (radius × 1.6, feather 50, opacity 100, sources from findHealSource). */
export function dustToSpots(
  candidates: { x: number; y: number; radius: number }[],
  px: PixelBuffer,
  idFactory: () => string,
): HealSpot[] {
  return candidates.map((c) => {
    const radius = c.radius * 1.6;
    const src = findHealSource(px, { x: c.x, y: c.y, radius });
    return { id: idFactory(), kind: 'heal', x: c.x, y: c.y, sx: src.x, sy: src.y, radius, feather: 50, opacity: 100 };
  });
}
