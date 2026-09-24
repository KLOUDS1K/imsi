/**
 * Linear / radial gradient mask geometry for the viewer.
 *
 * Both live in SOURCE-normalized space but are shaped in source PIXEL space
 * (a circle must stay a circle on a 3:2 photo): linear = start/end points,
 * lines perpendicular to start→end; radial = centre, radii rx·W and ry·H,
 * rotated by `angle` degrees (clockwise on screen, y down). Drawing samples the
 * shapes as polylines and maps every point through the geometry, so they stay
 * correct under rotation, keystone and lens correction.
 */
import type { LinearGradientParams, Point, RadialGradientParams } from '@/editor/types';
import { knob, pathD, stroke } from './draw';
import type { Mapping } from './host';

const DEG = Math.PI / 180;

/* ------------------------------- linear ------------------------------- */

export type LinearHandle = 'center' | 'start' | 'end' | 'rotate';

export interface LinearGeom {
  start: Point;
  end: Point;
  mid: Point;
  /** Canvas px of the rotation knob. */
  rotate: Point;
}

/** Points of the three lines (source-normalized), perpendicular to start→end in pixel space. */
function linearLines(g: LinearGradientParams, W: number, H: number): Point[][] {
  const dx = (g.x1 - g.x0) * W;
  const dy = (g.y1 - g.y0) * H;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal in pixels → normalized per axis.
  const nx = -dy / len / W;
  const ny = dx / len / H;
  const span = 1.6 * Math.hypot(W, H);
  const out: Point[][] = [];
  const bases = [
    { x: g.x0, y: g.y0 },
    { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 },
    { x: g.x1, y: g.y1 },
  ];
  for (const b of bases) {
    const pts: Point[] = [];
    for (let i = -16; i <= 16; i++) {
      const t = (i / 16) * span;
      pts.push({ x: b.x + nx * t, y: b.y + ny * t });
    }
    out.push(pts);
  }
  return out;
}

export function linearGeom(m: Mapping, g: LinearGradientParams): LinearGeom {
  const start = m.fromSource(g.x0, g.y0);
  const end = m.fromSource(g.x1, g.y1);
  const mid = m.fromSource((g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2);
  // Rotation knob: along the centre line, 56 px from the centre.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const rotate = { x: mid.x - (dy / len) * 56, y: mid.y + (dx / len) * 56 };
  return { start, end, mid, rotate };
}

export function drawLinear(g: SVGGElement, m: Mapping, lg: LinearGradientParams, selected: boolean): void {
  const lines = linearLines(lg, m.srcW, m.srcH);
  lines.forEach((pts, i) => stroke(g, pathD(pts.map((p) => m.fromSource(p.x, p.y))), i === 1 ? 'k-vo-mask' : 'k-vo-mask k-vo-mask--outer'));
  if (!selected) return;
  const geo = linearGeom(m, lg);
  stroke(g, pathD([geo.mid, geo.rotate]), 'k-vo-mask k-vo-mask--outer');
  knob(g, geo.start, 4);
  knob(g, geo.end, 4);
  knob(g, geo.rotate, 4, 'k-vo-knob--rotate');
}

export function hitLinear(m: Mapping, lg: LinearGradientParams, p: Point, tol: number): LinearHandle | null {
  const geo = linearGeom(m, lg);
  const d = (q: Point): number => Math.hypot(p.x - q.x, p.y - q.y);
  if (d(geo.rotate) <= tol) return 'rotate';
  if (d(geo.mid) <= tol + 2) return 'center';
  if (d(geo.start) <= tol) return 'start';
  if (d(geo.end) <= tol) return 'end';
  return null;
}

/** Drag a linear handle; `s` = pointer in source-normalized, `s0`/`g0` at drag start. */
export function dragLinear(h: LinearHandle, g0: LinearGradientParams, s0: Point, s: Point, W: number, H: number): LinearGradientParams {
  if (h === 'center') {
    const dx = s.x - s0.x;
    const dy = s.y - s0.y;
    return { x0: g0.x0 + dx, y0: g0.y0 + dy, x1: g0.x1 + dx, y1: g0.y1 + dy };
  }
  const mx = ((g0.x0 + g0.x1) / 2) * W;
  const my = ((g0.y0 + g0.y1) / 2) * H;
  if (h === 'rotate') {
    const a0 = Math.atan2(s0.y * H - my, s0.x * W - mx);
    const a1 = Math.atan2(s.y * H - my, s.x * W - mx);
    const da = a1 - a0;
    const c = Math.cos(da);
    const sn = Math.sin(da);
    const rot = (x: number, y: number): Point => {
      const px = x * W - mx;
      const py = y * H - my;
      return { x: (mx + px * c - py * sn) / W, y: (my + px * sn + py * c) / H };
    };
    const a = rot(g0.x0, g0.y0);
    const b = rot(g0.x1, g0.y1);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  // start / end: move along the gradient axis only (angle preserved).
  const ax = (g0.x1 - g0.x0) * W;
  const ay = (g0.y1 - g0.y0) * H;
  const len = Math.hypot(ax, ay) || 1;
  const ux = ax / len;
  const uy = ay / len;
  const fx = h === 'start' ? g0.x1 * W : g0.x0 * W;
  const fy = h === 'start' ? g0.y1 * H : g0.y0 * H;
  // Signed distance of the pointer from the fixed end along the axis.
  let t = (s.x * W - fx) * ux + (s.y * H - fy) * uy;
  const minLen = 2;
  if (h === 'start') t = Math.min(t, -minLen);
  else t = Math.max(t, minLen);
  const q = { x: (fx + ux * t) / W, y: (fy + uy * t) / H };
  return h === 'start' ? { ...g0, x0: q.x, y0: q.y } : { ...g0, x1: q.x, y1: q.y };
}

/* ------------------------------- radial ------------------------------- */

export type RadialHandle = 'move' | 'rx' | 'ry' | 'rotate' | 'feather';

/** Point on the ellipse at parameter t, scaled by k (1 = outer), source-normalized. */
function ellipsePoint(r: RadialGradientParams, W: number, H: number, t: number, k: number): Point {
  const a = r.rx * W * k;
  const b = r.ry * H * k;
  const c = Math.cos(r.angle * DEG);
  const s = Math.sin(r.angle * DEG);
  const ex = a * Math.cos(t);
  const ey = b * Math.sin(t);
  return { x: (r.cx * W + ex * c - ey * s) / W, y: (r.cy * H + ex * s + ey * c) / H };
}

function ellipsePath(m: Mapping, r: RadialGradientParams, k: number): string {
  const pts: Point[] = [];
  for (let i = 0; i <= 72; i++) {
    const p = ellipsePoint(r, m.srcW, m.srcH, (i / 72) * Math.PI * 2, k);
    pts.push(m.fromSource(p.x, p.y));
  }
  return pathD(pts, true);
}

const featherK = (r: RadialGradientParams): number => Math.max(0, 1 - r.feather / 100);

export function radialHandles(m: Mapping, r: RadialGradientParams): Record<Exclude<RadialHandle, 'move'>, Point> & { center: Point; rx2: Point; ry2: Point } {
  const at = (t: number, k = 1): Point => {
    const p = ellipsePoint(r, m.srcW, m.srcH, t, k);
    return m.fromSource(p.x, p.y);
  };
  const center = m.fromSource(r.cx, r.cy);
  const top = at(-Math.PI / 2);
  const dx = top.x - center.x;
  const dy = top.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    center,
    rx: at(0),
    rx2: at(Math.PI),
    ry: at(Math.PI / 2),
    ry2: top,
    rotate: { x: top.x + (dx / len) * 22, y: top.y + (dy / len) * 22 },
    feather: at(Math.PI / 4, Math.max(0.02, featherK(r))),
  };
}

export function drawRadial(g: SVGGElement, m: Mapping, r: RadialGradientParams, selected: boolean): void {
  stroke(g, ellipsePath(m, r, 1), 'k-vo-mask');
  if (!selected) return;
  const k = featherK(r);
  if (k > 0.02) stroke(g, ellipsePath(m, r, k), 'k-vo-mask k-vo-mask--outer');
  const hd = radialHandles(m, r);
  stroke(g, pathD([hd.ry2, hd.rotate]), 'k-vo-mask k-vo-mask--outer');
  for (const p of [hd.rx, hd.rx2, hd.ry, hd.ry2]) knob(g, p, 4);
  knob(g, hd.rotate, 4, 'k-vo-knob--rotate');
  knob(g, hd.feather, 3.5, 'k-vo-knob--feather');
}

/** Normalized elliptical radius of a source point (≤ 1 = inside). */
export function radialRho(r: RadialGradientParams, s: Point, W: number, H: number): number {
  const px = s.x * W - r.cx * W;
  const py = s.y * H - r.cy * H;
  const c = Math.cos(-r.angle * DEG);
  const sn = Math.sin(-r.angle * DEG);
  const qx = px * c - py * sn;
  const qy = px * sn + py * c;
  const a = Math.max(1e-6, r.rx * W);
  const b = Math.max(1e-6, r.ry * H);
  return Math.hypot(qx / a, qy / b);
}

export function hitRadial(m: Mapping, r: RadialGradientParams, p: Point, s: Point, tol: number, selected: boolean): RadialHandle | null {
  const d = (q: Point): number => Math.hypot(p.x - q.x, p.y - q.y);
  if (selected) {
    const hd = radialHandles(m, r);
    if (d(hd.rotate) <= tol) return 'rotate';
    if (d(hd.feather) <= tol) return 'feather';
    if (d(hd.rx) <= tol || d(hd.rx2) <= tol) return 'rx';
    if (d(hd.ry) <= tol || d(hd.ry2) <= tol) return 'ry';
  }
  return radialRho(r, s, m.srcW, m.srcH) <= 1 ? 'move' : null;
}

/** Drag a radial handle. `c0` = centre canvas px at drag start (for rotation). */
export function dragRadial(
  h: RadialHandle,
  r0: RadialGradientParams,
  s0: Point,
  s: Point,
  W: number,
  H: number,
  opts: { uniform: boolean; p0: Point; p: Point; c0: Point },
): RadialGradientParams {
  if (h === 'move') return { ...r0, cx: r0.cx + (s.x - s0.x), cy: r0.cy + (s.y - s0.y) };
  if (h === 'rotate') {
    const a0 = Math.atan2(opts.p0.y - opts.c0.y, opts.p0.x - opts.c0.x);
    const a1 = Math.atan2(opts.p.y - opts.c0.y, opts.p.x - opts.c0.x);
    let angle = r0.angle + (a1 - a0) / DEG;
    angle = ((((angle + 180) % 360) + 360) % 360) - 180;
    return { ...r0, angle: Math.round(angle * 10) / 10 };
  }
  // Pointer in the ellipse's local (unrotated) pixel frame.
  const px = s.x * W - r0.cx * W;
  const py = s.y * H - r0.cy * H;
  const c = Math.cos(-r0.angle * DEG);
  const sn = Math.sin(-r0.angle * DEG);
  const qx = px * c - py * sn;
  const qy = px * sn + py * c;
  if (h === 'feather') {
    const rho = Math.hypot(qx / Math.max(1e-6, r0.rx * W), qy / Math.max(1e-6, r0.ry * H));
    return { ...r0, feather: Math.round(Math.max(0, Math.min(100, (1 - rho) * 100))) };
  }
  const minPx = 2;
  if (h === 'rx') {
    const a = Math.max(minPx, Math.abs(qx));
    const rx = a / W;
    return opts.uniform ? { ...r0, rx, ry: r0.ry * (rx / Math.max(1e-9, r0.rx)) } : { ...r0, rx };
  }
  const b = Math.max(minPx, Math.abs(qy));
  const ry = b / H;
  return opts.uniform ? { ...r0, ry, rx: r0.rx * (ry / Math.max(1e-9, r0.ry)) } : { ...r0, ry };
}

/** New radial from a centre-out drag (source-normalized points). Shift = circle. */
export function radialFromDrag(c: Point, s: Point, W: number, H: number, circle: boolean): RadialGradientParams {
  let a = Math.abs(s.x - c.x) * W;
  let b = Math.abs(s.y - c.y) * H;
  if (circle) a = b = Math.hypot(a, b);
  a = Math.max(2, a);
  b = Math.max(2, b);
  return { cx: c.x, cy: c.y, rx: a / W, ry: b / H, angle: 0, feather: 50 };
}
