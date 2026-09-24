/**
 * Brush stroke rasterization (mask brush, heal/removal strokes).
 *
 * Model
 * - A stroke is a sequence of soft round dabs placed along a Catmull-Rom curve
 *   through its points, spaced `radius * DAB_SPACING` apart (arc length).
 * - Radius = stroke.size × source long edge (px). Feather 0..100 is the width
 *   of the smoothstep falloff ring (0 = hard edge with 1 px anti-aliasing,
 *   100 = falloff from the centre).
 * - Each dab adds `flow` of the remaining headroom up to the stroke's density
 *   cap: acc += (cap − acc) · flow · falloff. Dabs of one stroke therefore never
 *   exceed `density`, however often they overlap.
 * - Strokes composite in order into the brush component: paint strokes as a
 *   screen union (c + a − c·a), erase strokes as c · (1 − a).
 * - Pressure p (default 1) scales the radius by (0.5 + 0.5p) and the flow by
 *   (0.2 + 0.8p).
 *
 * Incremental rasterization: `BrushRaster.update()` recognises append-only
 * edits (new points on the last stroke, new strokes at the end) and only
 * stamps the new dabs. The last Catmull-Rom segment of the live stroke depends
 * on a point that does not exist yet, so it is stamped provisionally: the
 * accumulation pixels under it are snapshotted first and restored on the next
 * update. The incremental result is therefore bit-identical to a from-scratch
 * rasterization of the same strokes.
 */
import type { BrushStroke, Rect } from '@/editor/types';

export const DAB_SPACING = 1 / 6;
const ONE = 65535;

/** Integer pixel rect, exclusive x1/y1. */
export interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function unionRect(a: IRect | null, b: IRect | null): IRect | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

const radiusScale = (p: number) => 0.5 + 0.5 * p;
const flowScale = (p: number) => 0.2 + 0.8 * p;
const clampP = (p: number | undefined) => (p === undefined || !(p >= 0) ? 1 : p > 1 ? 1 : p);

/** Growable list of dabs (x, y, radius px, alpha) in pixel space. */
class DabList {
  data = new Float64Array(256);
  n = 0;
  push(x: number, y: number, r: number, a: number): void {
    if ((this.n + 1) * 4 > this.data.length) {
      const d = new Float64Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const o = this.n * 4;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = r;
    this.data[o + 3] = a;
    this.n++;
  }
  clear(): void {
    this.n = 0;
  }
}

interface Geom {
  w: number;
  h: number;
  long: number;
}

function dabParams(stroke: BrushStroke, g: Geom, pressure: number): { r: number; a: number } {
  const r = Math.max(0.5, stroke.size * g.long * radiusScale(pressure));
  const a = Math.max(0, Math.min(1, stroke.flow / 100)) * flowScale(pressure);
  return { r, a };
}

/** Uniform Catmull-Rom interpolation of one scalar. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Place dabs along segment `seg` (points[seg] → points[seg+1]) continuing from
 * `carry` (arc length travelled since the last dab). Returns the new carry.
 */
function walkSegment(stroke: BrushStroke, seg: number, carry: number, g: Geom, out: DabList): number {
  const pts = stroke.points;
  const n = pts.length;
  const P0 = pts[Math.max(0, seg - 1)]!;
  const P1 = pts[seg]!;
  const P2 = pts[seg + 1]!;
  const P3 = pts[Math.min(n - 1, seg + 2)]!;
  const x0 = P0.x * g.w, y0 = P0.y * g.h;
  const x1 = P1.x * g.w, y1 = P1.y * g.h;
  const x2 = P2.x * g.w, y2 = P2.y * g.h;
  const x3 = P3.x * g.w, y3 = P3.y * g.h;
  const pr1 = clampP(P1.pressure);
  const pr2 = clampP(P2.pressure);
  const chord = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.min(96, Math.ceil(chord / 3)));
  let ax = x1, ay = y1, apr = pr1;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const bx = cr(x0, x1, x2, x3, t);
    const by = cr(y0, y1, y2, y3, t);
    const bpr = pr1 + (pr2 - pr1) * t;
    const len = Math.hypot(bx - ax, by - ay);
    let pos = 0;
    // Walk this linear piece, dropping a dab every `spacing` px of arc length.
    for (;;) {
      const f = len > 0 ? pos / len : 0;
      const pr = apr + (bpr - apr) * f;
      const spacing = Math.max(0.5, dabParams(stroke, g, pr).r * DAB_SPACING);
      const need = spacing - carry;
      if (pos + need > len) {
        carry += len - pos;
        break;
      }
      pos += need;
      carry = 0;
      const u = len > 0 ? pos / len : 0;
      const dpr = apr + (bpr - apr) * u;
      const d = dabParams(stroke, g, dpr);
      out.push(ax + (bx - ax) * u, ay + (by - ay) * u, d.r, d.a);
    }
    ax = bx;
    ay = by;
    apr = bpr;
  }
  return carry;
}

function dabRect(x: number, y: number, r: number, w: number, h: number): IRect {
  return {
    x0: Math.max(0, Math.floor(x - r - 1)),
    y0: Math.max(0, Math.floor(y - r - 1)),
    x1: Math.min(w, Math.ceil(x + r + 1)),
    y1: Math.min(h, Math.ceil(y + r + 1)),
  };
}

function listRect(list: DabList, w: number, h: number): IRect | null {
  let rect: IRect | null = null;
  const d = list.data;
  for (let i = 0; i < list.n; i++) rect = unionRect(rect, dabRect(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!, w, h));
  if (rect && (rect.x1 <= rect.x0 || rect.y1 <= rect.y0)) return null;
  return rect;
}

/** Stamp one dab into a 16-bit accumulation buffer, capped at `cap` (0..65535). */
function stampDab(acc: Uint16Array, w: number, h: number, cx: number, cy: number, r: number, feather: number, alpha: number, cap: number): void {
  if (alpha <= 0 || cap <= 0) return;
  const rc = dabRect(cx, cy, r, w, h);
  const inner = r * (1 - feather);
  const ring = r - inner;
  const hard = ring < 1; // hard brush: 1 px anti-aliased edge
  const outer = r + 0.5;
  const outer2 = outer * outer;
  const inner2 = Math.max(0, inner - 0.5) ** 2;
  const invRing = hard ? 0 : 1 / ring;
  for (let y = rc.y0; y < rc.y1; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    if (dy2 >= outer2) continue;
    let i = y * w + rc.x0;
    for (let x = rc.x0; x < rc.x1; x++, i++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy2;
      if (d2 >= outer2) continue;
      let f: number;
      if (d2 <= inner2) f = 1;
      else {
        const d = Math.sqrt(d2);
        if (hard) f = r + 0.5 - d;
        else {
          const t = (r - d) * invRing;
          f = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        }
        if (f <= 0) continue;
        if (f > 1) f = 1;
      }
      const v = acc[i]!;
      if (v < cap) acc[i] = (v + (cap - v) * alpha * f + 0.5) | 0;
    }
  }
}

function sameParams(a: BrushStroke, b: BrushStroke): boolean {
  return a.size === b.size && a.feather === b.feather && a.flow === b.flow && a.density === b.density && a.erase === b.erase;
}

function samePoints(a: BrushStroke, b: BrushStroke, count: number): boolean {
  const pa = a.points;
  const pb = b.points;
  if (pa.length < count || pb.length < count) return false;
  if (pa === pb) return true;
  for (let i = 0; i < count; i++) {
    const p = pa[i]!;
    const q = pb[i]!;
    if (p !== q && (p.x !== q.x || p.y !== q.y || clampP(p.pressure) !== clampP(q.pressure))) return false;
  }
  return true;
}

function sameStroke(a: BrushStroke, b: BrushStroke): boolean {
  return a === b || (sameParams(a, b) && a.points.length === b.points.length && samePoints(a, b, a.points.length));
}

interface LiveStroke {
  stroke: BrushStroke;
  /** Points already consumed. */
  nPts: number;
  /** Next segment index whose dabs have not been stamped as final. */
  seg: number;
  carry: number;
  /** Extent of everything stamped into `acc` for this stroke. */
  bbox: IRect | null;
  /** Provisional last segment: acc pixels before it was stamped. */
  tail: { rect: IRect; data: Uint16Array } | null;
}

/** Incremental rasterizer for one brush component (or a heal/removal stroke set). */
export class BrushRaster {
  readonly w: number;
  readonly h: number;
  /** Coverage 0..255 (the component's output). */
  readonly out: Uint8Array;
  private base: Uint16Array;
  private acc: Uint16Array;
  private committed: BrushStroke[] = [];
  private live: LiveStroke | null = null;
  private dabs = new DabList();
  private g: Geom;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.g = { w, h, long: Math.max(w, h) };
    this.out = new Uint8Array(w * h);
    this.base = new Uint16Array(w * h);
    this.acc = new Uint16Array(w * h);
  }

  /** Approximate memory held (bytes). */
  get bytes(): number {
    return this.out.byteLength + this.base.byteLength + this.acc.byteLength;
  }

  /**
   * Bring `out` in sync with `strokes`. Returns the pixel rect of `out` that
   * changed (null = nothing changed).
   */
  update(strokes: readonly BrushStroke[]): IRect | null {
    const nc = this.committed.length;
    const need = nc + (this.live ? 1 : 0);
    let ok = strokes.length >= need;
    for (let i = 0; ok && i < nc; i++) ok = sameStroke(strokes[i]!, this.committed[i]!);
    if (ok && this.live) {
      const s = strokes[nc]!;
      ok = sameParams(s, this.live.stroke) && samePoints(s, this.live.stroke, this.live.nPts);
    }
    if (!ok) return this.rebuild(strokes);

    let dirty: IRect | null = null;
    let i = nc;
    if (this.live) {
      dirty = unionRect(dirty, this.extendLive(strokes[i]!));
      i++;
    }
    for (; i < strokes.length; i++) {
      this.foldLive();
      this.live = { stroke: strokes[i]!, nPts: 0, seg: 0, carry: 0, bbox: null, tail: null };
      dirty = unionRect(dirty, this.extendLive(strokes[i]!));
    }
    return dirty;
  }

  private rebuild(strokes: readonly BrushStroke[]): IRect | null {
    this.base.fill(0);
    this.acc.fill(0);
    this.out.fill(0);
    this.committed = [];
    this.live = null;
    for (const s of strokes) {
      this.foldLive();
      this.live = { stroke: s, nPts: 0, seg: 0, carry: 0, bbox: null, tail: null };
      this.extendLive(s);
    }
    return { x0: 0, y0: 0, x1: this.w, y1: this.h };
  }

  /** Stamp the dabs of `s` that are new relative to the live state. */
  private extendLive(s: BrushStroke): IRect | null {
    const live = this.live!;
    live.stroke = s;
    const n = s.points.length;
    if (n === live.nPts) return null;
    const { w, h, acc } = this;
    let dirty: IRect | null = null;
    // 1. Undo the provisional tail segment.
    if (live.tail) {
      const { rect, data } = live.tail;
      const rw = rect.x1 - rect.x0;
      for (let y = rect.y0, o = 0; y < rect.y1; y++, o += rw) acc.set(data.subarray(o, o + rw), y * w + rect.x0);
      dirty = rect;
      live.tail = null;
    }
    const feather = Math.max(0, Math.min(1, s.feather / 100));
    const cap = Math.round(Math.max(0, Math.min(1, s.density / 100)) * ONE);
    const list = this.dabs;
    list.clear();
    // 2. Final dabs: the stroke's first dab, then every segment whose next point is known.
    if (live.nPts === 0 && n >= 1) {
      const p = s.points[0]!;
      const d = dabParams(s, this.g, clampP(p.pressure));
      list.push(p.x * w, p.y * h, d.r, d.a);
    }
    for (; live.seg <= n - 3; live.seg++) live.carry = walkSegment(s, live.seg, live.carry, this.g, list);
    for (let k = 0; k < list.n; k++) {
      const o = k * 4;
      stampDab(acc, w, h, list.data[o]!, list.data[o + 1]!, list.data[o + 2]!, feather, list.data[o + 3]!, cap);
    }
    dirty = unionRect(dirty, listRect(list, w, h));
    // 3. Provisional tail (last segment, end point clamped).
    list.clear();
    if (n >= 2) {
      walkSegment(s, n - 2, live.carry, this.g, list);
      const rect = listRect(list, w, h);
      if (rect) {
        const rw = rect.x1 - rect.x0;
        const data = new Uint16Array(rw * (rect.y1 - rect.y0));
        for (let y = rect.y0, o = 0; y < rect.y1; y++, o += rw) data.set(acc.subarray(y * w + rect.x0, y * w + rect.x1), o);
        live.tail = { rect, data };
        for (let k = 0; k < list.n; k++) {
          const o = k * 4;
          stampDab(acc, w, h, list.data[o]!, list.data[o + 1]!, list.data[o + 2]!, feather, list.data[o + 3]!, cap);
        }
        dirty = unionRect(dirty, rect);
      }
    }
    live.nPts = n;
    live.bbox = unionRect(live.bbox, dirty);
    if (dirty) this.composite(dirty, s.erase);
    return dirty;
  }

  /** out = base ⊕ acc over `r` (the live stroke composited onto the committed ones). */
  private composite(r: IRect, erase: boolean): void {
    const { w, base, acc, out } = this;
    for (let y = r.y0; y < r.y1; y++) {
      let i = y * w + r.x0;
      const end = y * w + r.x1;
      for (; i < end; i++) {
        const b = base[i]!;
        const a = acc[i]!;
        const v = erase ? b - (b * a) / ONE : b + a - (b * a) / ONE;
        out[i] = (v * (255 / ONE) + 0.5) | 0;
      }
    }
  }

  /** Commit the live stroke into `base` (out is unchanged by this). */
  private foldLive(): void {
    const live = this.live;
    if (!live) return;
    const r = live.bbox;
    if (r) {
      const { w, base, acc } = this;
      const erase = live.stroke.erase;
      for (let y = r.y0; y < r.y1; y++) {
        const end = y * w + r.x1;
        for (let i = y * w + r.x0; i < end; i++) {
          const b = base[i]!;
          const a = acc[i]!;
          if (a === 0) continue;
          base[i] = (erase ? b - (b * a) / ONE : b + a - (b * a) / ONE) + 0.5;
          acc[i] = 0;
        }
      }
    }
    this.committed.push(live.stroke);
    this.live = null;
  }
}

/** Full (non-incremental) rasterization of strokes to coverage 0..255. */
export function rasterizeStrokes(strokes: BrushStroke[], width: number, height: number): Uint8Array {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = new BrushRaster(w, h);
  r.update(strokes);
  return r.out;
}

/**
 * Bounding box (source-normalized) of strokes including the brush radius.
 *
 * The brush radius is a fraction of the source LONG edge, so its extent in
 * normalized units differs per axis; pass the source aspect (width / height)
 * to get an exact box. Without it (the contract signature) the box assumes a
 * square source, which is exact on the long axis and too small on the short
 * one — pass the aspect wherever it is known.
 */
export function strokesBounds(strokes: BrushStroke[], aspect = 1): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // Normalized radius per unit `size` on each axis.
  const kx = a >= 1 ? 1 : 1 / a;
  const ky = a >= 1 ? a : 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const rx = s.size * kx;
    const ry = s.size * ky;
    for (const p of s.points) {
      x0 = Math.min(x0, p.x - rx);
      y0 = Math.min(y0, p.y - ry);
      x1 = Math.max(x1, p.x + rx);
      y1 = Math.max(y1, p.y + ry);
    }
  }
  if (!(x1 > x0) || !(y1 > y0)) return { x: 0, y: 0, w: 0, h: 0 };
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
  const cx1 = Math.min(1, x1), cy1 = Math.min(1, y1);
  return { x: cx0, y: cy0, w: Math.max(0, cx1 - cx0), h: Math.max(0, cy1 - cy0) };
}
