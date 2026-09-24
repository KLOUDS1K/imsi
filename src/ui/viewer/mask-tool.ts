/**
 * Masking tool (ctx.tool === 'masks'): component pins, brush / erase painting,
 * linear and radial gradients, colour / luminance / depth range samplers and
 * object selection. Everything is stored in SOURCE-normalized coordinates.
 *
 * History: every pointer gesture is one entry (beginGesture/endGesture).
 * Brush points are appended live while painting (rAF-coalesced set() calls
 * inside the gesture, flagged interactive → draft renders) and the gesture's
 * single entry is finalized at pointerup.
 */
import type { AppContext } from '@/app/context';
import { linearToSrgb, luminance } from '@/editor/color/math';
import { createMask } from '@/editor/defaults';
import type { BrushStroke, EditParams, Mask, MaskComponent, MaskComponentKind, Point, RGB } from '@/editor/types';
import { drawBrushRing, drawTrail, extendStroke, startStroke, type StrokeCapture } from './brush';
import { knob, pathD, stroke } from './draw';
import { dist, hitRadius, isFinitePoint, shownParams, type Mapping, type ToolCommand, type ViewerHost, type ViewerTool } from './host';
import {
  dragLinear,
  dragRadial,
  drawLinear,
  drawRadial,
  hitLinear,
  hitRadial,
  radialFromDrag,
  type LinearHandle,
  type RadialHandle,
} from './mask-shapes';
import { lookupDepth, sampleDepth } from './depth';

type Loc = { mi: number; ci: number };

type Drag =
  | { kind: 'paint'; cap: StrokeCapture; loc: Loc; si: number; erase: boolean; dirty: boolean }
  | { kind: 'linear-new'; s0: Point; p0: Point; loc: Loc | null }
  | { kind: 'linear'; handle: LinearHandle; loc: Loc; g0: NonNullable<MaskComponent['linear']>; s0: Point }
  | { kind: 'radial-new'; c: Point; p0: Point; loc: Loc | null }
  | { kind: 'radial'; handle: RadialHandle; loc: Loc; r0: NonNullable<MaskComponent['radial']>; s0: Point; p0: Point; c0: Point }
  | { kind: 'box'; p0: Point; p1: Point }
  | { kind: 'pin'; select: () => void };

const KIND_LABEL: Record<MaskComponentKind, string> = {
  brush: 'Brush',
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  'color-range': 'Color Range',
  'luminance-range': 'Luminance Range',
  'depth-range': 'Depth Range',
  ai: 'Object',
};

/** Where a component's pin sits (source-normalized), if it has a location. */
export function componentPin(c: MaskComponent): Point | null {
  switch (c.kind) {
    case 'brush': {
      const s = c.brush?.strokes.find((st) => !st.erase && st.points.length) ?? c.brush?.strokes.find((st) => st.points.length);
      return s ? { x: s.points[0].x, y: s.points[0].y } : null;
    }
    case 'linear':
      return c.linear ? { x: (c.linear.x0 + c.linear.x1) / 2, y: (c.linear.y0 + c.linear.y1) / 2 } : null;
    case 'radial':
      return c.radial ? { x: c.radial.cx, y: c.radial.cy } : null;
    case 'ai':
      if (c.ai?.point) return c.ai.point;
      if (c.ai?.box) return { x: c.ai.box.x + c.ai.box.w / 2, y: c.ai.box.y + c.ai.box.h / 2 };
      return null;
    default:
      return null;
  }
}

export function createMaskTool(host: ViewerHost): ViewerTool {
  const ctx: AppContext = host.ctx;
  let selectedId: string | null = null;
  /** Next drag on empty image creates a new linear/radial component. */
  let armed = true;
  let hover: Point | null = null;
  let drag: Drag | null = null;
  let flushRaf = 0;

  const store = () => ctx.doc.value?.store ?? null;
  const params = (): EditParams | null => store()?.params ?? null;
  const activeIndex = (p: EditParams): number => p.masks.findIndex((m) => m.id === ctx.activeMaskId.value);

  function locate(p: EditParams, id: string | null): Loc | null {
    if (!id) return null;
    for (let mi = 0; mi < p.masks.length; mi++) {
      const ci = p.masks[mi].components.findIndex((c) => c.id === id);
      if (ci >= 0) return { mi, ci };
    }
    return null;
  }
  const compAt = (p: EditParams, loc: Loc): MaskComponent | undefined => p.masks[loc.mi]?.components[loc.ci];
  const selected = (p: EditParams): MaskComponent | null => {
    const loc = locate(p, selectedId);
    return loc && loc.mi === activeIndex(p) ? (compAt(p, loc) ?? null) : null;
  };

  const offs = [
    ctx.maskDrawTool.subscribe(() => {
      armed = true;
      host.requestDraw();
    }),
    ctx.activeMaskId.subscribe(() => {
      armed = true;
      selectedId = null;
      host.requestDraw();
    }),
    ctx.brush.subscribe(() => host.requestDraw()),
  ];

  /** Add a component to the active mask (creating a mask when none is active). One history entry. */
  function addComponent(comp: MaskComponent): Loc | null {
    const st = store();
    if (!st) return null;
    let loc: Loc | null = null;
    let newMaskId: string | null = null;
    st.update(
      `Mask: Add ${KIND_LABEL[comp.kind]}`,
      (d) => {
        let mi = d.masks.findIndex((m) => m.id === ctx.activeMaskId.value);
        if (mi < 0) {
          const mask: Mask = createMask(`Mask ${d.masks.length + 1}`, ctx.newId('mask'));
          d.masks.push(mask);
          mi = d.masks.length - 1;
          newMaskId = mask.id;
        }
        const mask = d.masks[mi];
        if (!mask.components.length) comp.mode = 'add';
        mask.components.push(comp);
        loc = { mi, ci: mask.components.length - 1 };
      },
      { coalesceKey: null },
    );
    if (newMaskId) ctx.activeMaskId.set(newMaskId);
    selectedId = comp.id;
    armed = false;
    return loc;
  }

  function newComponent(kind: MaskComponentKind, fields: Partial<MaskComponent>): MaskComponent {
    return { id: ctx.newId('mc'), kind, mode: 'add', invert: false, ...fields };
  }

  function setComp<K extends keyof MaskComponent>(loc: Loc, key: K, value: MaskComponent[K], label: string): void {
    store()?.set(`masks.${loc.mi}.components.${loc.ci}.${String(key)}`, value, { label });
  }

  /* ------------------------------ sampling ------------------------------ */

  /** Linear source RGB under a canvas point (engine, falling back to the analysis proxy). */
  function sampleLinear(m: Mapping, p: Point): RGB | null {
    const o = m.toOutput(p.x, p.y);
    const e = ctx.engine;
    if (e && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1) {
      try {
        return e.sampleSourceLinear(o.x, o.y, m.params, 2);
      } catch {
        /* fall through */
      }
    }
    const px = ctx.doc.value?.analysisProxy;
    const s = m.toSource(p.x, p.y);
    if (!px || !isFinitePoint(s)) return null;
    const x = Math.min(px.width - 1, Math.max(0, Math.floor(s.x * px.width)));
    const y = Math.min(px.height - 1, Math.max(0, Math.floor(s.y * px.height)));
    const i = (y * px.width + x) * 4;
    const max = px.data instanceof Float32Array ? 1 : px.data instanceof Uint16Array ? 65535 : 255;
    const v = (k: number): number => px.data[i + k] / max;
    if (px.transfer === 'linear') return [v(0), v(1), v(2)];
    const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return [lin(v(0)), lin(v(1)), lin(v(2))];
  }

  function targetOf(p: EditParams, kind: MaskComponentKind): Loc | null {
    const sel = selected(p);
    if (sel && sel.kind === kind) return locate(p, sel.id);
    // Nothing selected: sample into the most recent component of this kind in the active
    // mask (e.g. the empty one "Create new mask → Range → Color" just added).
    const mi = activeIndex(p);
    const comps = mi >= 0 ? p.masks[mi]?.components ?? [] : [];
    for (let i = comps.length - 1; i >= 0; i--) if (comps[i].kind === kind) return locate(p, comps[i].id);
    return null;
  }

  function sampleColor(m: Mapping, p: Point, add: boolean): void {
    const cur = params();
    const lin = sampleLinear(m, p);
    if (!cur || !lin) return;
    const rgb: RGB = [linearToSrgb(Math.max(0, lin[0])), linearToSrgb(Math.max(0, lin[1])), linearToSrgb(Math.max(0, lin[2]))].map(
      (v) => Math.round(Math.min(1, v) * 1000) / 1000,
    ) as RGB;
    const loc = targetOf(cur, 'color-range');
    if (loc) {
      const cr = compAt(cur, loc)?.colorRange ?? { samples: [], range: 50 };
      const samples = add ? [...cr.samples, rgb].slice(-5) : [rgb];
      setComp(loc, 'colorRange', { ...cr, samples }, 'Color Range: Sample');
    } else addComponent(newComponent('color-range', { colorRange: { samples: [rgb], range: 50 } }));
  }

  function sampleLuminance(m: Mapping, p: Point): void {
    const cur = params();
    const lin = sampleLinear(m, p);
    if (!cur || !lin) return;
    const L = linearToSrgb(Math.max(0, luminance(lin[0], lin[1], lin[2])));
    const w = 0.12;
    const range = { min: Math.max(0, L - w), max: Math.min(1, L + w), featherLow: 0.1, featherHigh: 0.1 };
    const loc = targetOf(cur, 'luminance-range');
    if (loc) setComp(loc, 'luminanceRange', range, 'Luminance Range: Sample');
    else addComponent(newComponent('luminance-range', { luminanceRange: range }));
  }

  async function sampleDepthAt(m: Mapping, p: Point): Promise<void> {
    const doc = ctx.doc.value;
    const s = m.toSource(p.x, p.y);
    if (!doc || !isFinitePoint(s)) return;
    const depth = await lookupDepth(ctx, doc);
    if (!depth || ctx.doc.value !== doc) return;
    const d = sampleDepth(depth, s.x, s.y);
    const cur = params();
    if (!cur) return;
    const w = 0.1;
    const range = { min: Math.max(0, d - w), max: Math.min(1, d + w), feather: 0.1 };
    const loc = targetOf(cur, 'depth-range');
    if (loc) setComp(loc, 'depthRange', range, 'Depth Range: Sample');
    else addComponent(newComponent('depth-range', { depthRange: range }));
  }

  function setObject(m: Mapping, a: Point, b: Point | null): void {
    const cur = params();
    if (!cur) return;
    const sa = m.toSource(a.x, a.y);
    if (!isFinitePoint(sa)) return;
    let ai: NonNullable<MaskComponent['ai']>;
    if (b && dist(a, b) > 6) {
      const sb = m.toSource(b.x, b.y);
      if (!isFinitePoint(sb)) return;
      const x0 = Math.max(0, Math.min(sa.x, sb.x));
      const y0 = Math.max(0, Math.min(sa.y, sb.y));
      const x1 = Math.min(1, Math.max(sa.x, sb.x));
      const y1 = Math.min(1, Math.max(sa.y, sb.y));
      ai = { target: 'object', box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    } else ai = { target: 'object', point: { x: Math.min(1, Math.max(0, sa.x)), y: Math.min(1, Math.max(0, sa.y)) } };
    const sel = selected(cur);
    const loc = sel && sel.kind === 'ai' && sel.ai?.target === 'object' ? locate(cur, sel.id) : null;
    if (loc) setComp(loc, 'ai', ai, 'Object: Select');
    else addComponent(newComponent('ai', { ai }));
  }

  /* ------------------------------ painting ------------------------------ */

  function startPaint(m: Mapping, p: Point, e: PointerEvent): boolean {
    const st = store();
    const cur = params();
    if (!st || !cur) return false;
    const cap = startStroke(m, p, e);
    if (!cap) return false;
    const toolErase = ctx.maskDrawTool.value === 'erase';
    const wantErase = toolErase !== e.altKey;
    const b = ctx.brush.value;
    st.beginGesture(wantErase ? 'Brush: Erase' : 'Brush');
    // Target component: painting goes to an 'add' brush, erasing erases an 'add'
    // brush or, when the mask has none, paints into a 'subtract' brush.
    let loc: Loc | null = null;
    let si = 0;
    let erase = false;
    let newMaskId: string | null = null;
    let newCompId: string | null = null;
    st.update(
      wantErase ? 'Brush: Erase' : 'Brush',
      (d) => {
        let mi = d.masks.findIndex((mk) => mk.id === ctx.activeMaskId.value);
        if (mi < 0) {
          const mask = createMask(`Mask ${d.masks.length + 1}`, ctx.newId('mask'));
          d.masks.push(mask);
          mi = d.masks.length - 1;
          newMaskId = mask.id;
        }
        const comps = d.masks[mi].components;
        const brushes = comps.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'brush');
        const sel = brushes.find((x) => x.c.id === selectedId);
        const addB = sel && sel.c.mode !== 'subtract' ? sel : [...brushes].reverse().find((x) => x.c.mode !== 'subtract');
        const subB = sel && sel.c.mode === 'subtract' ? sel : [...brushes].reverse().find((x) => x.c.mode === 'subtract');
        let ci: number;
        if (!wantErase) {
          if (addB) ci = addB.i;
          else {
            comps.push({ id: ctx.newId('mc'), kind: 'brush', mode: 'add', invert: false, brush: { strokes: [] } });
            ci = comps.length - 1;
            newCompId = comps[ci].id;
          }
        } else if (addB) {
          ci = addB.i;
          erase = true;
        } else if (subB) ci = subB.i;
        else {
          comps.push({ id: ctx.newId('mc'), kind: 'brush', mode: comps.length ? 'subtract' : 'add', invert: false, brush: { strokes: [] } });
          ci = comps.length - 1;
          newCompId = comps[ci].id;
        }
        const comp = comps[ci];
        comp.brush ??= { strokes: [] };
        const s: BrushStroke = { points: cap.points.slice(), size: b.size, feather: b.feather, flow: b.flow, density: b.density, erase };
        comp.brush.strokes.push(s);
        si = comp.brush.strokes.length - 1;
        loc = { mi, ci };
        if (!newCompId) newCompId = comp.id;
      },
      { coalesceKey: null },
    );
    if (!loc) {
      st.endGesture();
      return false;
    }
    if (newMaskId) ctx.activeMaskId.set(newMaskId);
    selectedId = newCompId;
    drag = { kind: 'paint', cap, loc, si, erase: wantErase, dirty: false };
    return true;
  }

  function strokePath(d: Extract<Drag, { kind: 'paint' }>): string {
    return `masks.${d.loc.mi}.components.${d.loc.ci}.brush.strokes.${d.si}.points`;
  }

  /**
   * Push the captured points into the stroke. Inside the gesture every set()
   * rewrites the gesture's single history entry (so the entry always matches
   * the params) and is flagged interactive, so the shell renders in draft.
   */
  function flushPaint(d: Drag | null, final: boolean): void {
    if (flushRaf) cancelAnimationFrame(flushRaf);
    flushRaf = 0;
    const st = store();
    if (!d || d.kind !== 'paint' || !st) return;
    if (!d.dirty && !final) return;
    d.dirty = false;
    st.set(strokePath(d), d.cap.points.slice(), { label: d.erase ? 'Brush: Erase' : 'Brush' });
  }

  /* ------------------------------ pins ------------------------------ */

  interface Pin {
    at: Point;
    select: () => void;
    active: boolean;
    selected: boolean;
    kind: MaskComponentKind;
  }

  function pins(m: Mapping, p: EditParams): Pin[] {
    const out: Pin[] = [];
    const ai = activeIndex(p);
    p.masks.forEach((mask, mi) => {
      if (mi !== ai) {
        if (!mask.visible) return;
        for (const c of mask.components) {
          const s = componentPin(c);
          if (!s) continue;
          out.push({ at: m.fromSource(s.x, s.y), active: false, selected: false, kind: c.kind, select: () => ctx.activeMaskId.set(mask.id) });
          break;
        }
        return;
      }
      for (const c of mask.components) {
        const s = componentPin(c);
        if (!s) continue;
        out.push({
          at: m.fromSource(s.x, s.y),
          active: true,
          selected: c.id === selectedId,
          kind: c.kind,
          select: () => {
            selectedId = c.id;
            armed = false;
          },
        });
      }
    });
    return out.filter((q) => isFinitePoint(q.at));
  }

  /* ------------------------------ tool ------------------------------ */

  const drawTool = () => ctx.maskDrawTool.value;
  const isPaintTool = (): boolean => drawTool() === 'brush' || drawTool() === 'erase';

  const tool: ViewerTool = {
    name: 'masks',

    onPointerDown(e, p) {
      const m = host.mapping();
      const cur = params();
      if (!m || !cur || e.button !== 0) return false;
      const tol = hitRadius(e);
      const s = m.toSource(p.x, p.y);
      const sel = selected(cur);
      const selLoc = sel ? locate(cur, sel.id) : null;
      // 1) Handles of the selected gradient.
      if (sel && selLoc && sel.kind === 'linear' && sel.linear) {
        const h = hitLinear(m, sel.linear, p, tol);
        if (h) {
          store()?.beginGesture('Linear Gradient');
          drag = { kind: 'linear', handle: h, loc: selLoc, g0: { ...sel.linear }, s0: s };
          return true;
        }
      }
      if (sel && selLoc && sel.kind === 'radial' && sel.radial && drawTool() !== 'brush' && drawTool() !== 'erase') {
        const h = isFinitePoint(s) ? hitRadial(m, sel.radial, p, s, tol, true) : null;
        if (h && (h !== 'move' || drawTool() === 'radial' || drawTool() === 'none')) {
          store()?.beginGesture('Radial Gradient');
          drag = { kind: 'radial', handle: h, loc: selLoc, r0: { ...sel.radial }, s0: s, p0: p, c0: m.fromSource(sel.radial.cx, sel.radial.cy) };
          return true;
        }
      }
      // 2) Pins (select; unselected gradient pins select then drag-move).
      const pin = pins(m, cur).find((q) => dist(q.at, p) <= tol);
      if (pin) {
        drag = { kind: 'pin', select: pin.select };
        return true;
      }
      if (!isFinitePoint(s)) return false;
      // 3) The drawing tool.
      switch (drawTool()) {
        case 'brush':
        case 'erase':
          return startPaint(m, p, e);
        case 'linear':
          if (!armed && sel?.kind === 'linear') return false;
          drag = { kind: 'linear-new', s0: s, p0: p, loc: null };
          return true;
        case 'radial':
          if (!armed && sel?.kind === 'radial') return false;
          drag = { kind: 'radial-new', c: s, p0: p, loc: null };
          return true;
        case 'object':
          drag = { kind: 'box', p0: p, p1: p };
          return true;
        case 'color-range':
          sampleColor(m, p, e.shiftKey);
          return true;
        case 'luminance-range':
          sampleLuminance(m, p);
          return true;
        case 'depth-range':
          void sampleDepthAt(m, p);
          return true;
        default:
          return false;
      }
    },

    onPointerMove(e, p) {
      const m = host.mapping();
      const d = drag;
      if (!m || !d) return;
      hover = p;
      const s = m.toSource(p.x, p.y);
      switch (d.kind) {
        case 'paint': {
          const b = ctx.brush.value;
          const r = isFinitePoint(s) ? m.radiusPx(s.x, s.y, b.size) : 10;
          if (extendStroke(d.cap, m, e, host.local, Math.max(1.5, r * 0.12))) {
            d.dirty = true;
            if (!flushRaf) flushRaf = requestAnimationFrame(() => flushPaint(drag, false));
          }
          break;
        }
        case 'linear-new': {
          if (!isFinitePoint(s) || dist(p, d.p0) < 5) break;
          const g = { x0: d.s0.x, y0: d.s0.y, x1: s.x, y1: s.y };
          if (!d.loc) {
            store()?.beginGesture('Linear Gradient');
            d.loc = addComponent(newComponent('linear', { linear: g }));
          } else setComp(d.loc, 'linear', g, 'Linear Gradient');
          break;
        }
        case 'linear': {
          if (!isFinitePoint(s)) break;
          setComp(d.loc, 'linear', dragLinear(d.handle, d.g0, d.s0, s, m.srcW, m.srcH), 'Linear Gradient');
          break;
        }
        case 'radial-new': {
          if (!isFinitePoint(s) || dist(p, d.p0) < 5) break;
          const r = radialFromDrag(d.c, s, m.srcW, m.srcH, e.shiftKey);
          if (!d.loc) {
            store()?.beginGesture('Radial Gradient');
            d.loc = addComponent(newComponent('radial', { radial: r }));
          } else setComp(d.loc, 'radial', r, 'Radial Gradient');
          break;
        }
        case 'radial': {
          if (!isFinitePoint(s)) break;
          const r = dragRadial(d.handle, d.r0, d.s0, s, m.srcW, m.srcH, { uniform: e.shiftKey, p0: d.p0, p, c0: d.c0 });
          setComp(d.loc, 'radial', r, 'Radial Gradient');
          break;
        }
        case 'box':
          d.p1 = p;
          break;
        default:
          break;
      }
      host.requestDraw();
    },

    onPointerUp(_e, p) {
      const d = drag;
      drag = null;
      const m = host.mapping();
      if (!d) return;
      switch (d.kind) {
        case 'paint':
          flushPaint(d, true);
          store()?.endGesture();
          break;
        case 'linear-new':
        case 'radial-new':
          if (d.loc) store()?.endGesture();
          break;
        case 'linear':
        case 'radial':
          store()?.endGesture();
          break;
        case 'box':
          if (m) setObject(m, d.p0, dist(d.p0, p) > 6 ? p : null);
          break;
        case 'pin':
          d.select();
          break;
      }
      host.requestDraw();
    },

    onCancel() {
      const d = drag;
      drag = null;
      if (flushRaf) cancelAnimationFrame(flushRaf);
      flushRaf = 0;
      const st = store();
      if (!d || !st) return;
      if (d.kind === 'paint' || ((d.kind === 'linear-new' || d.kind === 'radial-new') && d.loc)) {
        // A second finger turned the gesture into a pinch: drop the partial edit.
        st.endGesture();
        st.undo();
      } else if (d.kind === 'linear' || d.kind === 'radial') st.endGesture();
      host.requestDraw();
    },

    onHover(p) {
      hover = p;
      if (isPaintTool()) host.requestDraw();
    },

    cursor(p, e) {
      const m = host.mapping();
      const cur = params();
      if (!m || !cur) return 'default';
      const tol = hitRadius(e);
      if (pins(m, cur).some((q) => dist(q.at, p) <= tol)) return 'pointer';
      const sel = selected(cur);
      if (sel?.kind === 'linear' && sel.linear) {
        const h = hitLinear(m, sel.linear, p, tol);
        if (h) return h === 'center' ? 'move' : 'grab';
      }
      if (sel?.kind === 'radial' && sel.radial && !isPaintTool()) {
        const s = m.toSource(p.x, p.y);
        const h = isFinitePoint(s) ? hitRadial(m, sel.radial, p, s, tol, true) : null;
        if (h) return h === 'move' ? 'move' : 'grab';
      }
      if (isPaintTool()) return 'none';
      return drawTool() === 'none' ? 'default' : 'crosshair';
    },

    command(cmd: ToolCommand) {
      const st = store();
      const cur = params();
      switch (cmd) {
        case 'size-up':
        case 'size-down': {
          const f = cmd === 'size-up' ? 1.15 : 1 / 1.15;
          ctx.brush.set({ ...ctx.brush.value, size: Math.min(0.5, Math.max(0.001, ctx.brush.value.size * f)) });
          return true;
        }
        case 'feather-up':
        case 'feather-down': {
          const dv = cmd === 'feather-up' ? 10 : -10;
          ctx.brush.set({ ...ctx.brush.value, feather: Math.min(100, Math.max(0, ctx.brush.value.feather + dv)) });
          return true;
        }
        case 'delete': {
          const loc = cur ? locate(cur, selectedId) : null;
          if (!st || !loc) return false;
          st.update('Mask: Delete Component', (d) => void d.masks[loc.mi].components.splice(loc.ci, 1), { coalesceKey: null });
          selectedId = null;
          host.requestDraw();
          return true;
        }
        case 'escape':
          if (selectedId) selectedId = null;
          else if (ctx.maskDrawTool.value !== 'none') ctx.maskDrawTool.set('none');
          else ctx.tool.set('edit');
          host.requestDraw();
          return true;
        case 'enter':
          ctx.maskDrawTool.set('none');
          ctx.tool.set('edit');
          return true;
        default:
          return false;
      }
    },

    draw(g, m) {
      const cur = shownParams(ctx);
      if (!cur) return;
      const ai = activeIndex(cur);
      const mask = ai >= 0 ? cur.masks[ai] : null;
      const painting = drag?.kind === 'paint';
      if (mask && !painting) {
        for (const c of mask.components) {
          const isSel = c.id === selectedId;
          if (c.kind === 'linear' && c.linear) drawLinear(g, m, c.linear, isSel);
          else if (c.kind === 'radial' && c.radial) drawRadial(g, m, c.radial, isSel);
          else if (c.kind === 'ai' && c.ai?.box && isSel) {
            const a = m.fromSource(c.ai.box.x, c.ai.box.y);
            const b = m.fromSource(c.ai.box.x + c.ai.box.w, c.ai.box.y + c.ai.box.h);
            stroke(g, pathD([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], true), 'k-vo-mask k-vo-mask--outer');
          }
        }
      }
      if (!painting) {
        for (const pin of pins(m, cur)) knob(g, pin.at, pin.active ? 5 : 4, pin.selected ? 'k-vo-pin is-selected' : pin.active ? 'k-vo-pin' : 'k-vo-pin is-inactive');
      }
      if (drag?.kind === 'box') stroke(g, pathD([drag.p0, { x: drag.p1.x, y: drag.p0.y }, drag.p1, { x: drag.p0.x, y: drag.p1.y }], true), 'k-vo-mask');
      if (drag?.kind === 'paint' && drag.cap.trail.length > 1) {
        const b = ctx.brush.value;
        const s = drag.cap.points[0];
        drawTrail(g, drag.cap.trail, 2 * m.radiusPx(s.x, s.y, b.size), drag.erase ? 'k-vo-trail k-vo-trail--erase' : 'k-vo-trail');
      }
      if (isPaintTool() && hover) {
        const b = ctx.brush.value;
        const erase = (drawTool() === 'erase') !== host.altDown();
        drawBrushRing(g, m, hover, b.size, b.feather, erase);
      }
    },

    dispose() {
      if (drag) tool.onCancel?.();
      for (const off of offs) off();
    },
  };
  return tool;
}
