/**
 * Valid-crop search for "Constrain to image". A frame-normalized rect is valid
 * when it lies inside the frame and every point of it maps (frame → source)
 * onto real source pixels.
 *
 * The valid region V is the image of the source rectangle under the forward
 * map. It is a topological disc (continuous bijection of a rectangle), so a
 * rect whose BOUNDARY lies in V lies in V entirely — we only test boundary
 * samples. Without lens distortion every step is projective (lines stay
 * lines) and V is convex, so the four corners suffice; with distortion the
 * edges of V curve and each rect edge is sampled densely.
 *
 * maxValidCrop: for a fixed centre, validity is monotone in the rect size
 * (V is convex / star-shaped around interior points), so the largest size is
 * found by bisection. The centre (and, for a free aspect, the log-aspect) is
 * then optimized by a compass/pattern search, which handles asymmetric cases
 * (offsets, keystone) where the best crop is not centred.
 */
import type { Point, Rect } from '../../types';
import { type GeometryPlan, mapOutToSource } from './geometry-core';

/** Tolerance in source-normalized units (float noise on exact-fit edges). */
const SRC_EPS = 1e-7;
/** Tolerance for the rect vs. the frame bounds. */
const FRAME_EPS = 1e-9;
const SAMPLES_PER_EDGE_DISTORTED = 24;

const tmp: Point = { x: 0, y: 0 };

function pointValid(plan: GeometryPlan, u: number, v: number): boolean {
  if (!mapOutToSource(plan, u, v, tmp)) return false;
  return tmp.x >= -SRC_EPS && tmp.x <= 1 + SRC_EPS && tmp.y >= -SRC_EPS && tmp.y <= 1 + SRC_EPS;
}

/** `plan` must be built with ignoreCrop = true (maps frame coords). */
export function rectValidInPlan(plan: GeometryPlan, rect: Rect): boolean {
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) return false;
  if (x < -FRAME_EPS || y < -FRAME_EPS || x + w > 1 + FRAME_EPS || y + h > 1 + FRAME_EPS) return false;
  const n = plan.hasDistortion ? SAMPLES_PER_EDGE_DISTORTED : 1;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Walk the four edges; together they visit every corner exactly once.
    if (!pointValid(plan, x + w * t, y)) return false;
    if (!pointValid(plan, x + w, y + h * t)) return false;
    if (!pointValid(plan, x + w * (1 - t), y + h)) return false;
    if (!pointValid(plan, x, y + h * (1 - t))) return false;
  }
  return true;
}

interface Candidate {
  cx: number;
  cy: number;
  /** ln of the normalized aspect k = w_n / h_n */
  t: number;
  /** normalized height of the best valid rect */
  h: number;
  score: number;
}

function rectAt(cx: number, cy: number, k: number, h: number): Rect {
  const w = k * h;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Largest valid normalized height for a rect centred at (cx, cy) with w_n = k·h_n. */
function bestHeight(plan: GeometryPlan, cx: number, cy: number, k: number): number {
  if (!(cx > 0 && cx < 1 && cy > 0 && cy < 1)) return 0;
  let hi = Math.min(2 * cy, 2 * (1 - cy), (2 * cx) / k, (2 * (1 - cx)) / k);
  if (!(hi > 0)) return 0;
  if (rectValidInPlan(plan, rectAt(cx, cy, k, hi))) return hi;
  if (!pointValid(plan, cx, cy)) return 0;
  let lo = 0;
  for (let i = 0; i < 26; i++) {
    const mid = 0.5 * (lo + hi);
    if (rectValidInPlan(plan, rectAt(cx, cy, k, mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Largest valid crop (frame-normalized) with pixel aspect `aspect` (w/h), or
 * the largest-AREA valid crop when `aspect` is null. Returns a zero-size rect
 * at the frame centre when no valid pixel exists near it.
 * `hint` = extra start centres (e.g. the current crop centre).
 */
export function searchMaxValidCrop(plan: GeometryPlan, aspect: number | null, hints: Point[] = []): Rect {
  const free = aspect === null || !(aspect > 0) || !Number.isFinite(aspect);
  // Normalized aspect k = w_n/h_n = aspect · frameH / frameW.
  const pixToNorm = plan.frameH / plan.frameW;
  const kFixed = free ? 1 : (aspect as number) * pixToNorm;

  const evaluate = (cx: number, cy: number, t: number): Candidate => {
    const k = free ? Math.exp(t) : kFixed;
    const h = bestHeight(plan, cx, cy, k);
    // Maximizing area (k·h²) is equivalent to maximizing h when k is fixed.
    return { cx, cy, t, h, score: k * h * h };
  };

  const starts: Point[] = [{ x: 0.5, y: 0.5 }, ...hints];
  // The image centre mapped into the frame is a good start under offsets/keystone.
  const lensToFrameCentre: Point = { x: 0, y: 0 };
  {
    const m = plan.lensToOut;
    const w = m[6] * 0.5 + m[7] * 0.5 + m[8];
    if (w > 1e-12) {
      lensToFrameCentre.x = (m[0] * 0.5 + m[1] * 0.5 + m[2]) / w;
      lensToFrameCentre.y = (m[3] * 0.5 + m[4] * 0.5 + m[5]) / w;
      starts.push(lensToFrameCentre);
    }
  }

  let best: Candidate | null = null;
  for (const s of starts) {
    const cx = Math.min(1 - 1e-6, Math.max(1e-6, s.x));
    const cy = Math.min(1 - 1e-6, Math.max(1e-6, s.y));
    const c = evaluate(cx, cy, 0);
    if (!best || c.score > best.score) best = c;
  }
  let cur = best as Candidate;

  // Compass search. Steps shrink geometrically; the evaluation budget bounds
  // the worst case (each evaluation is ~26 bisection steps × edge samples).
  let step = 0.125;
  let stepT = 0.5;
  let budget = 320;
  const dirs: [number, number, number][] = free
    ? [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  while (step > 2e-5 && budget > 0) {
    let improved = false;
    for (const [dx, dy, dt] of dirs) {
      if (budget-- <= 0) break;
      const c = evaluate(cur.cx + dx * step, cur.cy + dy * step, cur.t + dt * stepT);
      if (c.score > cur.score * (1 + 1e-9) + 1e-15) {
        cur = c;
        improved = true;
      }
    }
    if (!improved) {
      step *= 0.5;
      stepT *= 0.5;
    }
  }

  if (!(cur.h > 0)) return { x: 0.5, y: 0.5, w: 0, h: 0 };
  const k = free ? Math.exp(cur.t) : kFixed;
  return rectAt(cur.cx, cur.cy, k, cur.h);
}
