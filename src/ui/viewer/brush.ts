/**
 * Freehand stroke capture shared by the mask brush and the AI-remove /
 * generative retouch tools: pointer samples (incl. coalesced events) → spaced
 * source-normalized BrushPoints; plus the size/feather ring cursor.
 */
import type { BrushPoint, Point } from '@/editor/types';
import { circlePath, label, pathD, stroke } from './draw';
import { isFinitePoint, type Mapping } from './host';

export interface StrokeCapture {
  points: BrushPoint[];
  /** Canvas px of the last accepted sample. */
  last: Point;
  /** Canvas px trail for the overlay preview. */
  trail: Point[];
}

/** Pen pressure (0..1) or undefined for mouse/touch (engine default = 1). */
export function pressureOf(e: PointerEvent): number | undefined {
  return e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 1000) / 1000 : undefined;
}

export function startStroke(m: Mapping, p: Point, e: PointerEvent): StrokeCapture | null {
  const s = m.toSource(p.x, p.y);
  if (!isFinitePoint(s)) return null;
  const pr = pressureOf(e);
  return { points: [pr === undefined ? { x: s.x, y: s.y } : { x: s.x, y: s.y, pressure: pr }], last: p, trail: [p] };
}

/**
 * Append the move's samples (coalesced events give smooth strokes at high
 * pointer rates). A point is kept when it moved ≥ `spacing` canvas px.
 * Returns true when points were added.
 */
export function extendStroke(cap: StrokeCapture, m: Mapping, e: PointerEvent, local: (e: { clientX: number; clientY: number }) => Point, spacing: number): boolean {
  const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  const list = events.length ? events : [e];
  let added = false;
  for (const ev of list) {
    const p = local(ev);
    if (Math.hypot(p.x - cap.last.x, p.y - cap.last.y) < spacing) continue;
    const s = m.toSource(p.x, p.y);
    if (!isFinitePoint(s)) continue;
    const pr = pressureOf(ev);
    cap.points.push(pr === undefined ? { x: s.x, y: s.y } : { x: s.x, y: s.y, pressure: pr });
    cap.last = p;
    cap.trail.push(p);
    added = true;
  }
  return added;
}

/** Brush ring cursor: outer = size, dashed inner = hard core (1 − feather). */
export function drawBrushRing(g: SVGGElement, m: Mapping, p: Point, size: number, feather: number, erase: boolean): void {
  const s = m.toSource(p.x, p.y);
  const r = isFinitePoint(s) ? m.radiusPx(s.x, s.y, size) : size * Math.max(m.srcW, m.srcH) * m.t.scale;
  stroke(g, circlePath(p, r), 'k-vo-ring');
  const inner = r * (1 - Math.max(0, Math.min(100, feather)) / 100);
  if (inner > 2 && inner < r - 1) stroke(g, circlePath(p, inner), 'k-vo-ring k-vo-ring--inner');
  if (erase) label(g, { x: p.x, y: p.y + 4 }, '−', 'k-vo-text--sign');
  else stroke(g, pathD([{ x: p.x - 3, y: p.y }, { x: p.x + 3, y: p.y }]) + pathD([{ x: p.x, y: p.y - 3 }, { x: p.x, y: p.y + 3 }]), 'k-vo-cross');
}

/** Live stroke trail (thick translucent path in canvas px). */
export function drawTrail(g: SVGGElement, trail: Point[], widthPx: number, cls: string): void {
  if (!trail.length) return;
  const d = trail.length === 1 ? pathD([trail[0], { x: trail[0].x + 0.01, y: trail[0].y }]) : pathD(trail);
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  el.setAttribute('class', cls);
  el.style.strokeWidth = `${Math.max(1, widthPx).toFixed(1)}px`;
  g.appendChild(el);
}
