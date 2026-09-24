/**
 * Tiny SVG builders for the overlay. Every visible line is drawn twice — a
 * wider translucent "shade" stroke under a thin "ink" stroke — so guides read on
 * both bright and dark photos. Colours come from viewer.css (token-derived).
 */
import { svg } from '@/ui/dom';
import type { Point } from '@/editor/types';

const f = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0');

export function pathD(points: Point[], close = false): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    d += `${d ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`;
  }
  return close && d ? `${d}Z` : d;
}

/** Shaded line/path (ink over shade). `cls` adds a modifier class to both. */
export function stroke(g: SVGGElement, d: string, cls = ''): void {
  if (!d) return;
  g.appendChild(svg('path', { d, class: `k-vo-shade ${cls}` }));
  g.appendChild(svg('path', { d, class: `k-vo-ink ${cls}` }));
}

export function line(g: SVGGElement, a: Point, b: Point, cls = ''): void {
  stroke(g, `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`, cls);
}

export function circlePath(c: Point, r: number): string {
  if (!(r > 0)) return '';
  return `M${f(c.x - r)} ${f(c.y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`;
}

export function ring(g: SVGGElement, c: Point, r: number, cls = ''): void {
  stroke(g, circlePath(c, r), cls);
}

/** Filled handle dot (knob) with an outline. */
export function knob(g: SVGGElement, c: Point, r: number, cls = ''): void {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
  g.appendChild(svg('circle', { cx: f(c.x), cy: f(c.y), r: f(r + 1.5), class: `k-vo-knob-shade ${cls}` }));
  g.appendChild(svg('circle', { cx: f(c.x), cy: f(c.y), r: f(r), class: `k-vo-knob ${cls}` }));
}

/** Square crop handle. */
export function square(g: SVGGElement, c: Point, s: number, cls = ''): void {
  g.appendChild(svg('rect', { x: f(c.x - s / 2), y: f(c.y - s / 2), width: f(s), height: f(s), class: `k-vo-knob ${cls}` }));
}

/** Filled area (e.g. the dimmed region outside the crop, evenodd). */
export function fill(g: SVGGElement, d: string, cls: string): void {
  if (!d) return;
  g.appendChild(svg('path', { d, class: cls, 'fill-rule': 'evenodd' }));
}

/** Arrow head at `b` pointing from `a`. */
export function arrow(g: SVGGElement, a: Point, b: Point, size = 7, cls = ''): void {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const p1 = { x: b.x - size * Math.cos(ang - 0.45), y: b.y - size * Math.sin(ang - 0.45) };
  const p2 = { x: b.x - size * Math.cos(ang + 0.45), y: b.y - size * Math.sin(ang + 0.45) };
  stroke(g, pathD([p1, b, p2]), cls);
}

/** Small on-image text label (chip). */
export function label(g: SVGGElement, p: Point, text: string, cls = ''): void {
  const t = svg('text', { x: f(p.x), y: f(p.y), class: `k-vo-text ${cls}` });
  t.textContent = text;
  g.appendChild(t);
}
