/**
 * Pure crop-rectangle math (frame-normalized rects, no DOM, unit-tested).
 *
 * All rects are in the crop tool's FRAME space (0..1 each axis). Aspect ratios
 * given as `ratio` are NORMALIZED (w/h of the normalized rect), i.e. the pixel
 * aspect × frameH / frameW — see `normalizedRatio`.
 */
import type { AspectPreset, CropParams, Point, Rect } from '@/editor/types';

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const CROP_HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest crop edge, normalized. */
export const MIN_CROP = 0.02;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Pixel aspect (w/h) → normalized ratio for a frame of frameW×frameH. */
export function normalizedRatio(pixelAspect: number | null, frameW: number, frameH: number): number | null {
  if (pixelAspect === null || !(pixelAspect > 0)) return null;
  return (pixelAspect * frameH) / Math.max(1, frameW);
}

/** Handle direction: -1 = moves the left/top edge, 1 = right/bottom, 0 = untouched axis. */
export function handleDir(h: CropHandle): { dx: -1 | 0 | 1; dy: -1 | 0 | 1 } {
  return {
    dx: h.includes('w') ? -1 : h.includes('e') ? 1 : 0,
    dy: h.startsWith('n') ? -1 : h.startsWith('s') ? 1 : 0,
  };
}

/** Handle position on a rect (normalized). */
export function handlePoint(r: Rect, h: CropHandle): Point {
  const { dx, dy } = handleDir(h);
  return { x: r.x + (r.w * (dx + 1)) / 2, y: r.y + (r.h * (dy + 1)) / 2 };
}

/**
 * Resize `start` by dragging handle `h` to the normalized pointer `p`. The
 * opposite edge/corner stays fixed; edge handles with an aspect lock grow the
 * other axis symmetrically about its centre. The result stays inside [0,1]².
 */
export function resizeCrop(start: Rect, h: CropHandle, p: Point, ratio: number | null, minSize = MIN_CROP): Rect {
  const { dx, dy } = handleDir(h);
  const x0 = start.x;
  const y0 = start.y;
  const x1 = start.x + start.w;
  const y1 = start.y + start.h;
  // Fixed anchor (opposite side) and available room from it towards the drag.
  const ax = dx > 0 ? x0 : x1;
  const ay = dy > 0 ? y0 : y1;
  const roomX = dx > 0 ? 1 - ax : ax;
  const roomY = dy > 0 ? 1 - ay : ay;

  if (dx !== 0 && dy !== 0) {
    // Corner.
    let w = clamp((p.x - ax) * dx, minSize, roomX);
    let hh = clamp((p.y - ay) * dy, minSize, roomY);
    if (ratio) {
      // Follow whichever axis the pointer pulled further (relative to the ratio).
      if (w / ratio >= hh) hh = w / ratio;
      else w = hh * ratio;
      if (w > roomX) {
        w = roomX;
        hh = w / ratio;
      }
      if (hh > roomY) {
        hh = roomY;
        w = hh * ratio;
      }
      if (w < minSize || hh < minSize) {
        const s = Math.max(minSize / w, minSize / hh);
        w *= s;
        hh *= s;
      }
    }
    return { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - hh, w, h: hh };
  }

  if (dx !== 0) {
    // Left/right edge.
    let w = clamp((p.x - ax) * dx, minSize, roomX);
    if (!ratio) return { x: dx > 0 ? ax : ax - w, y: start.y, w, h: start.h };
    const cy = start.y + start.h / 2;
    let hh = w / ratio;
    const maxH = 2 * Math.min(cy, 1 - cy);
    if (hh > maxH) {
      hh = maxH;
      w = hh * ratio;
    }
    return { x: dx > 0 ? ax : ax - w, y: cy - hh / 2, w, h: hh };
  }

  // Top/bottom edge.
  let hh = clamp((p.y - ay) * dy, minSize, roomY);
  if (!ratio) return { x: start.x, y: dy > 0 ? ay : ay - hh, w: start.w, h: hh };
  const cx = start.x + start.w / 2;
  let w = hh * ratio;
  const maxW = 2 * Math.min(cx, 1 - cx);
  if (w > maxW) {
    w = maxW;
    hh = w / ratio;
  }
  return { x: cx - w / 2, y: dy > 0 ? ay : ay - hh, w, h: hh };
}

/** Translate `start` by (dx, dy), kept inside the frame. */
export function moveCrop(start: Rect, dx: number, dy: number): Rect {
  return {
    x: clamp(start.x + dx, 0, Math.max(0, 1 - start.w)),
    y: clamp(start.y + dy, 0, Math.max(0, 1 - start.h)),
    w: start.w,
    h: start.h,
  };
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
}

/**
 * Walk from a VALID rect towards `target` and return the furthest rect on the
 * way that is still valid (binary search; `valid` is monotone enough for crop
 * moves/resizes). Used for "constrain to image".
 */
export function limitToValid(start: Rect, target: Rect, valid: (r: Rect) => boolean, iterations = 14): Rect {
  if (valid(target)) return target;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (valid(lerpRect(start, target, mid))) lo = mid;
    else hi = mid;
  }
  return lerpRect(start, target, lo);
}

/** Scale `r` about `anchor` by s. */
export function scaleRect(r: Rect, s: number, anchor: Point): Rect {
  return { x: anchor.x + (r.x - anchor.x) * s, y: anchor.y + (r.y - anchor.y) * s, w: r.w * s, h: r.h * s };
}

/**
 * Largest scaled copy of `r` (about its centre) that is valid, or null when even
 * a tiny rect at that centre is invalid (centre outside the image).
 */
export function shrinkToValid(r: Rect, valid: (r: Rect) => boolean, iterations = 16): Rect | null {
  if (valid(r)) return r;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const minS = Math.min(1, (MIN_CROP * 0.5) / Math.max(1e-6, Math.min(r.w, r.h)));
  if (!valid(scaleRect(r, minS, c))) return null;
  let lo = minS;
  let hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (valid(scaleRect(r, mid, c))) lo = mid;
    else hi = mid;
  }
  return scaleRect(r, lo, c);
}

/** Keep a rect inside the unit square (shrinking about its centre if needed). */
export function fitInFrame(r: Rect): Rect {
  const s = Math.min(1, 1 / Math.max(r.w, 1e-9), 1 / Math.max(r.h, 1e-9));
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const scaled = s < 1 ? scaleRect(r, s, c) : r;
  return moveCrop(scaled, 0, 0);
}

/** A rect of normalized ratio `ratio`, centred on `r`, with about the same area, inside the frame. */
export function conformToRatio(r: Rect, ratio: number): Rect {
  const area = Math.max(MIN_CROP * MIN_CROP, r.w * r.h);
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;
  const s = Math.min(1, 1 / w, 1 / h);
  w *= s;
  h *= s;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  return moveCrop({ x: c.x - w / 2, y: c.y - h / 2, w, h }, 0, 0);
}

/** Swap the rect's PIXEL width/height (portrait ↔ landscape) about its centre. */
export function swapRectOrientation(r: Rect, frameW: number, frameH: number): Rect {
  const pw = r.w * frameW;
  const ph = r.h * frameH;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const w = ph / frameW;
  const h = pw / frameH;
  return fitInFrame({ x: c.x - w / 2, y: c.y - h / 2, w, h });
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

const PRESET_RATIOS: [AspectPreset, number, number][] = [
  ['1:1', 1, 1],
  ['3:2', 3, 2],
  ['2:3', 2, 3],
  ['4:3', 4, 3],
  ['5:4', 5, 4],
  ['4:5', 4, 5],
  ['16:9', 16, 9],
];

/**
 * Aspect settings with the orientation swapped. `aspectRatioValue` is literal
 * ('4:3' is always landscape), so the swap picks the inverse preset when one
 * exists and a custom ratio otherwise. 'free' stays free.
 */
export function swappedAspect(crop: Pick<CropParams, 'aspect' | 'customAspect'>, frameW: number, frameH: number): Pick<CropParams, 'aspect' | 'customAspect'> {
  let a: number;
  let b: number;
  switch (crop.aspect) {
    case 'free':
      return { aspect: 'free', customAspect: crop.customAspect };
    case 'original': {
      const g = gcd(frameW, frameH);
      a = frameW / g;
      b = frameH / g;
      if (a > 10000 || b > 10000) {
        a = Math.round((frameW / frameH) * 1000);
        b = 1000;
      }
      break;
    }
    case 'custom':
      [a, b] = crop.customAspect;
      break;
    default: {
      const found = PRESET_RATIOS.find((p) => p[0] === crop.aspect);
      if (!found) return { aspect: crop.aspect, customAspect: crop.customAspect };
      [, a, b] = found;
    }
  }
  // Swapped ratio b:a — prefer a named preset.
  const hit = PRESET_RATIOS.find((p) => p[1] * a === p[2] * b);
  if (hit) return { aspect: hit[0], customAspect: crop.customAspect };
  return { aspect: 'custom', customAspect: [b, a] };
}

/**
 * Straighten: angle change (degrees, positive = content clockwise) that makes a
 * screen line with direction (dx, dy) horizontal, or vertical when it is closer
 * to vertical.
 */
export function straightenDelta(dx: number, dy: number): number {
  let t = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Direction does not matter: fold to (-90, 90].
  if (t > 90) t -= 180;
  else if (t <= -90) t += 180;
  if (Math.abs(t) <= 45) return -t;
  return -(t - Math.sign(t) * 90);
}

/** Signed angle (degrees, clockwise on screen positive) from vector a to vector b. */
export function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI;
}

/** Round to 0.01° and keep inside the params range. */
export function clampAngle(a: number): number {
  return Math.round(clamp(a, -45, 45) * 100) / 100;
}

export function rectsClose(a: Rect, b: Rect, eps = 1e-5): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
}
