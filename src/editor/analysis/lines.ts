/**
 * Straight-line detection for straighten / upright (and the scene classifier).
 *
 * Canny-lite edges (Gaussian → Sobel → non-maximum suppression → threshold)
 * vote into two small Hough accumulators, one for near-vertical and one for
 * near-horizontal lines (normal angle within ±maxTilt of the axis). Each edge
 * pixel only votes for angles within ±6° of its own gradient orientation,
 * which removes most texture clutter. Peaks are then refined by a total
 * least-squares fit of the supporting edge pixels of the longest contiguous
 * run, which gives sub-0.05° accuracy on clean lines — far finer than the
 * 0.25° accumulator bins.
 *
 * Coordinates of returned segments are in plane pixels, y down.
 */
import type { LumaPlane } from './buffer';
import { gaussianBlur, quantile, sobel } from './stats';

export interface LineSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
  /** 'v' = near-vertical (y0 < y1), 'h' = near-horizontal (x0 < x1). */
  family: 'v' | 'h';
  /** Mean gradient magnitude along the segment (edge contrast). */
  strength: number;
}

export interface LineOptions {
  /** Max deviation from the axis, degrees. Default 20. */
  maxTilt?: number;
  /** Minimum segment length as a fraction of the short image side. Default 0.08. */
  minLength?: number;
  /** Max number of segments per family. Default 40. */
  maxLines?: number;
}

const ANG_STEP = 0.25;
const VOTE_SPREAD = 6;
const DEG = Math.PI / 180;

interface EdgeSet {
  x: Float32Array;
  y: Float32Array;
  /** normal angle relative to the family axis, degrees */
  phi: Float32Array;
  mag: Float32Array;
  n: number;
}

export function detectLines(p: LumaPlane, opts: LineOptions = {}): LineSegment[] {
  const maxTilt = opts.maxTilt ?? 20;
  const { width: w, height: h } = p;
  const minLen = Math.max(12, (opts.minLength ?? 0.08) * Math.min(w, h));
  const maxLines = opts.maxLines ?? 40;
  const sm = gaussianBlur(p.data, w, h, 1.0);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  sobel(sm, w, h, gx, gy);
  const mag = new Float32Array(w * h);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  const thr = Math.max(0.01, quantile(mag, 0.8));

  // Non-maximum suppression along the gradient (4 sectors), then split by family.
  const tanLim = Math.tan((maxTilt + 4) * DEG);
  const cap = Math.min(w * h, 400_000);
  const vE = allocEdges(cap);
  const hE = allocEdges(cap);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < thr) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let n1: number;
      let n2: number;
      if (ay <= ax * 0.4142) {
        n1 = mag[i - 1];
        n2 = mag[i + 1];
      } else if (ax <= ay * 0.4142) {
        n1 = mag[i - w];
        n2 = mag[i + w];
      } else if (gx[i] * gy[i] > 0) {
        n1 = mag[i - w - 1];
        n2 = mag[i + w + 1];
      } else {
        n1 = mag[i - w + 1];
        n2 = mag[i + w - 1];
      }
      if (m < n1 || m < n2) continue;
      if (ay <= ax * tanLim && vE.n < cap) {
        // Near-vertical line: normal ≈ x axis. Fold the gradient sign away.
        pushEdge(vE, x - cx, y - cy, Math.atan(gy[i] / gx[i]) / DEG, m);
      } else if (ax <= ay * tanLim && hE.n < cap) {
        // Near-horizontal line: normal ≈ y axis; angle measured from +y towards -x.
        pushEdge(hE, x - cx, y - cy, Math.atan(-gx[i] / gy[i]) / DEG, m);
      }
    }
  }
  const diag = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const out: LineSegment[] = [];
  for (const [edges, fam] of [
    [vE, 'v'],
    [hE, 'h'],
  ] as const) {
    const segs = houghFamily(edges, fam, maxTilt, diag, minLen, maxLines);
    for (const s of segs) {
      out.push({ ...s, x0: s.x0 + cx, y0: s.y0 + cy, x1: s.x1 + cx, y1: s.y1 + cy });
    }
  }
  return out;
}

function allocEdges(cap: number): EdgeSet {
  return { x: new Float32Array(cap), y: new Float32Array(cap), phi: new Float32Array(cap), mag: new Float32Array(cap), n: 0 };
}

function pushEdge(e: EdgeSet, x: number, y: number, phi: number, m: number): void {
  const k = e.n++;
  e.x[k] = x;
  e.y[k] = y;
  e.phi[k] = phi;
  e.mag[k] = m;
}

/**
 * Family geometry. For 'v' the line is  x·cosφ + y·sinφ = ρ  (normal near +x);
 * for 'h' it is  −x·sinφ + y·cosφ = ρ  (normal near +y). The direction along
 * the line is the normal rotated by 90°.
 */
function rhoOf(fam: 'v' | 'h', x: number, y: number, c: number, s: number): number {
  return fam === 'v' ? x * c + y * s : -x * s + y * c;
}

function houghFamily(e: EdgeSet, fam: 'v' | 'h', maxTilt: number, diag: number, minLen: number, maxLines: number): LineSegment[] {
  if (e.n < minLen) return [];
  const T = maxTilt + 2;
  const nA = Math.round((2 * T) / ANG_STEP) + 1;
  const nR = 2 * diag + 1;
  const cosT = new Float32Array(nA);
  const sinT = new Float32Array(nA);
  for (let a = 0; a < nA; a++) {
    const phi = (-T + a * ANG_STEP) * DEG;
    cosT[a] = Math.cos(phi);
    sinT[a] = Math.sin(phi);
  }
  const acc = new Float32Array(nA * nR);
  const spread = Math.round(VOTE_SPREAD / ANG_STEP);
  for (let k = 0; k < e.n; k++) {
    const x = e.x[k];
    const y = e.y[k];
    const a0 = Math.round((e.phi[k] + T) / ANG_STEP);
    const lo = Math.max(0, a0 - spread);
    const hi = Math.min(nA - 1, a0 + spread);
    for (let a = lo; a <= hi; a++) {
      const r = Math.round(rhoOf(fam, x, y, cosT[a], sinT[a])) + diag;
      acc[a * nR + r] += 1;
    }
  }
  // Peaks: local maxima in a 5×5 window with enough votes.
  const minVotes = minLen * 0.7;
  const peaks: { a: number; r: number; v: number }[] = [];
  for (let a = 0; a < nA; a++) {
    for (let r = 2; r < nR - 2; r++) {
      const v = acc[a * nR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let da = -2; da <= 2 && isMax; da++) {
        const aa = a + da;
        if (aa < 0 || aa >= nA) continue;
        for (let dr = -2; dr <= 2; dr++) {
          if (!da && !dr) continue;
          const o = acc[aa * nR + r + dr];
          if (o > v || (o === v && (da < 0 || (da === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ a, r, v });
    }
  }
  peaks.sort((p, q) => q.v - p.v);
  const segs: LineSegment[] = [];
  const kept: { phi: number; rho: number }[] = [];
  const px = new Float32Array(e.n);
  const py = new Float32Array(e.n);
  const pt = new Float32Array(e.n);
  const pm = new Float32Array(e.n);
  for (const pk of peaks) {
    if (segs.length >= maxLines) break;
    const phi = -T + pk.a * ANG_STEP;
    const rho = pk.r - diag;
    if (kept.some((q) => Math.abs(q.phi - phi) < 1.5 && Math.abs(q.rho - rho) < 5)) continue;
    kept.push({ phi, rho });
    const seg = refine(e, fam, phi, rho, minLen, diag, px, py, pt, pm);
    if (seg) segs.push(seg);
  }
  return segs;
}

/** Collect supporting pixels, find the longest gap-free run, TLS-fit it. */
function refine(
  e: EdgeSet,
  fam: 'v' | 'h',
  phiDeg: number,
  rho: number,
  minLen: number,
  diag: number,
  px: Float32Array,
  py: Float32Array,
  pt: Float32Array,
  pm: Float32Array,
): LineSegment | null {
  const c = Math.cos(phiDeg * DEG);
  const s = Math.sin(phiDeg * DEG);
  let n = 0;
  for (let k = 0; k < e.n; k++) {
    if (Math.abs(e.phi[k] - phiDeg) > 8) continue;
    const x = e.x[k];
    const y = e.y[k];
    if (Math.abs(rhoOf(fam, x, y, c, s) - rho) > 1.6) continue;
    px[n] = x;
    py[n] = y;
    // Position along the line direction.
    pt[n] = fam === 'v' ? -x * s + y * c : x * c + y * s;
    pm[n] = e.mag[k];
    n++;
  }
  if (n < minLen * 0.5) return null;
  // Occupancy along t, 1-px buckets.
  const size = 2 * diag + 1;
  const occ = new Uint8Array(size);
  for (let k = 0; k < n; k++) occ[Math.max(0, Math.min(size - 1, Math.round(pt[k]) + diag))] = 1;
  const maxGap = Math.max(4, Math.round(minLen * 0.12));
  let bestS = -1;
  let bestE = -1;
  let runS = -1;
  let last = -1;
  for (let t = 0; t < size; t++) {
    if (!occ[t]) continue;
    if (runS < 0 || t - last > maxGap) runS = t;
    last = t;
    if (last - runS > bestE - bestS) {
      bestS = runS;
      bestE = last;
    }
  }
  if (bestS < 0 || bestE - bestS < minLen) return null;
  const tLo = bestS - diag - 0.5;
  const tHi = bestE - diag + 0.5;
  // TLS fit of the run's points.
  let mx = 0;
  let my = 0;
  let cnt = 0;
  let strength = 0;
  for (let k = 0; k < n; k++) {
    if (pt[k] < tLo || pt[k] > tHi) continue;
    mx += px[k];
    my += py[k];
    strength += pm[k];
    cnt++;
  }
  if (cnt < minLen * 0.5) return null;
  mx /= cnt;
  my /= cnt;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    if (pt[k] < tLo || pt[k] > tHi) continue;
    const dx = px[k] - mx;
    const dy = py[k] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Principal direction of the scatter.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(theta);
  let dy = Math.sin(theta);
  if (fam === 'v' && dy < 0) {
    dx = -dx;
    dy = -dy;
  }
  if (fam === 'h' && dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  // Extent along the fitted direction.
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < n; k++) {
    if (pt[k] < tLo || pt[k] > tHi) continue;
    const t = (px[k] - mx) * dx + (py[k] - my) * dy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const length = hi - lo;
  if (length < minLen) return null;
  return {
    x0: mx + dx * lo,
    y0: my + dy * lo,
    x1: mx + dx * hi,
    y1: my + dy * hi,
    length,
    family: fam,
    strength: strength / cnt,
  };
}

/**
 * Rotation (degrees, positive = clockwise, the crop.angle convention) that
 * makes a segment exactly horizontal/vertical.
 *
 * With y down, rotating content clockwise by θ maps a direction (dx, dy) to
 * (dx·cosθ − dy·sinθ, dx·sinθ + dy·cosθ). A near-horizontal segment becomes
 * horizontal when tanθ = −dy/dx; a near-vertical one becomes vertical when
 * tanθ = dx/dy.
 */
export function levelingRotation(s: Pick<LineSegment, 'x0' | 'y0' | 'x1' | 'y1' | 'family'>): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  return s.family === 'h' ? -Math.atan2(dy, dx) / DEG : Math.atan2(dx, dy) / DEG;
}
