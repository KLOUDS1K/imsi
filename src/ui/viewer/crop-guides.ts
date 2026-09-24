/**
 * Crop composition overlays as SVG path data inside a canvas-space rect:
 * thirds, golden ratio (φ grid), golden spiral (8 orientations), grid,
 * diagonals, plus the fine grid shown while rotating.
 */
import type { CropOverlay, Point, Rect } from '@/editor/types';
import { pathD } from './draw';

const PHI_INV = 0.6180339887;

function vLine(r: Rect, f: number): string {
  const x = r.x + r.w * f;
  return `M${x.toFixed(2)} ${r.y.toFixed(2)}V${(r.y + r.h).toFixed(2)}`;
}
function hLine(r: Rect, f: number): string {
  const y = r.y + r.h * f;
  return `M${r.x.toFixed(2)} ${y.toFixed(2)}H${(r.x + r.w).toFixed(2)}`;
}

/** Evenly spaced grid with roughly `cell` px cells. */
export function gridPath(r: Rect, cell: number): string {
  const nx = Math.max(2, Math.round(r.w / cell));
  const ny = Math.max(2, Math.round(r.h / cell));
  let d = '';
  for (let i = 1; i < nx; i++) d += vLine(r, i / nx);
  for (let i = 1; i < ny; i++) d += hLine(r, i / ny);
  return d;
}

/** 45° lines from each corner (Lightroom "Diagonal"). */
function diagonalPath(r: Rect): string {
  const s = Math.min(r.w, r.h);
  const pts: [Point, Point][] = [
    [{ x: r.x, y: r.y }, { x: r.x + s, y: r.y + s }],
    [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w - s, y: r.y + s }],
    [{ x: r.x, y: r.y + r.h }, { x: r.x + s, y: r.y + r.h - s }],
    [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x + r.w - s, y: r.y + r.h - s }],
  ];
  return pts.map(([a, b]) => pathD([a, b])).join('');
}

/**
 * Golden spiral in the unit square (quarter arcs in successively cut φ
 * rectangles, see the step table below), then flipped/transposed per
 * `orientation` (0..7) and stretched to the rect — as Lightroom does.
 */
export function goldenSpiralPath(r: Rect, orientation: number): string {
  const arcs: Point[] = [];
  const cuts: [Point, Point][] = [];
  let x = 0;
  let y = 0;
  let w = 1;
  let h = 1;
  const seg = 14;
  for (let i = 0; i < 12; i++) {
    const step = i % 4;
    for (let k = 0; k <= seg; k++) {
      // Skip the duplicate first point of every arc after the first.
      if (k === 0 && i > 0) continue;
      const t = (k / seg) * (Math.PI / 2);
      const c = Math.cos(t);
      const s = Math.sin(t);
      if (step === 0) {
        const a = w * PHI_INV;
        arcs.push({ x: x + a - a * c, y: y + h - h * s });
      } else if (step === 1) {
        const a = h * PHI_INV;
        arcs.push({ x: x + w * s, y: y + a - a * c });
      } else if (step === 2) {
        const a = w * PHI_INV;
        arcs.push({ x: x + w - a + a * c, y: y + h * s });
      } else {
        const a = h * PHI_INV;
        arcs.push({ x: x + w - w * s, y: y + h - a + a * c });
      }
    }
    if (step === 0) {
      const a = w * PHI_INV;
      cuts.push([{ x: x + a, y }, { x: x + a, y: y + h }]);
      x += a;
      w -= a;
    } else if (step === 1) {
      const a = h * PHI_INV;
      cuts.push([{ x, y: y + a }, { x: x + w, y: y + a }]);
      y += a;
      h -= a;
    } else if (step === 2) {
      const a = w * PHI_INV;
      cuts.push([{ x: x + w - a, y }, { x: x + w - a, y: y + h }]);
      w -= a;
    } else {
      const a = h * PHI_INV;
      cuts.push([{ x, y: y + h - a }, { x: x + w, y: y + h - a }]);
      h -= a;
    }
  }
  const o = ((orientation % 8) + 8) % 8;
  const flipX = (o & 1) !== 0;
  const flipY = (o & 2) !== 0;
  const transpose = (o & 4) !== 0;
  const map = (p: Point): Point => {
    let u = transpose ? p.y : p.x;
    let v = transpose ? p.x : p.y;
    if (flipX) u = 1 - u;
    if (flipY) v = 1 - v;
    return { x: r.x + u * r.w, y: r.y + v * r.h };
  };
  let d = pathD(arcs.map(map));
  for (const [a, b] of cuts.slice(0, 6)) d += pathD([map(a), map(b)]);
  return d;
}

/** Path data for an overlay inside rect `r` (canvas px). */
export function overlayPath(kind: CropOverlay, r: Rect, spiralOrientation = 0): string {
  switch (kind) {
    case 'thirds':
      return vLine(r, 1 / 3) + vLine(r, 2 / 3) + hLine(r, 1 / 3) + hLine(r, 2 / 3);
    case 'golden-ratio':
      return vLine(r, 1 - PHI_INV) + vLine(r, PHI_INV) + hLine(r, 1 - PHI_INV) + hLine(r, PHI_INV);
    case 'golden-spiral':
      return goldenSpiralPath(r, spiralOrientation);
    case 'grid':
      return gridPath(r, Math.max(28, Math.min(r.w, r.h) / 8));
    case 'diagonal':
      return diagonalPath(r);
    default:
      return '';
  }
}

export const OVERLAY_CYCLE: readonly CropOverlay[] = ['thirds', 'golden-ratio', 'golden-spiral', 'grid', 'diagonal', 'none'];

export const OVERLAY_LABELS: Record<CropOverlay, string> = {
  none: 'None',
  thirds: 'Rule of Thirds',
  'golden-ratio': 'Golden Ratio',
  'golden-spiral': 'Golden Spiral',
  grid: 'Grid',
  diagonal: 'Diagonal',
};
