/**
 * Healing tool (ctx.tool === 'heal').
 *
 * - heal / clone / content-aware: click adds a circular spot (radius from
 *   ctx.retouchBrush.size, a fraction of the source long edge). The source is
 *   auto-picked with inpaint.findHealSource on the analysis proxy. Drag the
 *   destination or source circle, resize with the knob (or [ ]), Delete removes.
 * - ai-remove / generative: paint a stroke → inpaint.createRemovalPatch (worker,
 *   progress in ctx.busy) → pixels into ctx.patchStore, patch into
 *   params.retouch.removals as ONE history step.
 */
import type { AppContext } from '@/app/context';
import type { BrushStroke, EditParams, HealSpot, PixelBuffer, Point, RemovalPatch } from '@/editor/types';
import { drawBrushRing, drawTrail, extendStroke, startStroke, type StrokeCapture } from './brush';
import { arrow, knob, line, ring } from './draw';
import { dist, hitRadius, isFinitePoint, shownParams, type Mapping, type ToolCommand, type ViewerHost, type ViewerTool } from './host';

type InpaintApi = typeof import('@/editor/ai/inpaint');

let inpaintPromise: Promise<InpaintApi | null> | null = null;
/** Lazy-load the inpainting module (PatchMatch + workers) on first use. */
export function loadInpaint(): Promise<InpaintApi | null> {
  inpaintPromise ??= import('@/editor/ai/inpaint').catch((err: unknown) => {
    console.error('inpaint module unavailable', err);
    inpaintPromise = null;
    return null;
  });
  return inpaintPromise;
}

/** Fallback source when the heal-source search is unavailable: 2.5 radii towards the image centre. */
export function fallbackSource(x: number, y: number, radius: number, W: number, H: number): Point {
  const long = Math.max(W, H);
  const rPx = radius * long;
  let dx = W / 2 - x * W;
  let dy = H / 2 - y * H;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const off = 2.5 * rPx;
  return {
    x: Math.min(1, Math.max(0, x + (dx * off) / W)),
    y: Math.min(1, Math.max(0, y + (dy * off) / H)),
  };
}

type Drag =
  | { kind: 'new'; p0: Point; s0: Point; moved: boolean }
  | { kind: 'dest' | 'src'; idx: number; s0: Point; spot0: HealSpot }
  | { kind: 'radius'; idx: number; spot0: HealSpot }
  | { kind: 'paint'; cap: StrokeCapture }
  | { kind: 'select-removal'; id: string };

export function createHealTool(host: ViewerHost): ViewerTool {
  const ctx: AppContext = host.ctx;
  let selectedSpot: string | null = null;
  let selectedRemoval: string | null = null;
  let hover: Point | null = null;
  let drag: Drag | null = null;
  /** Strokes being inpainted (drawn until the patch lands). */
  const pending: { trail: Point[]; size: number; s: Point }[] = [];
  let disposed = false;

  void loadInpaint();

  const store = () => ctx.doc.value?.store ?? null;
  const params = (): EditParams | null => store()?.params ?? null;
  const isRemoval = (): boolean => ctx.retouchTool.value === 'ai-remove' || ctx.retouchTool.value === 'generative';

  const offs = [ctx.retouchTool.subscribe(() => host.requestDraw()), ctx.retouchBrush.subscribe(() => host.requestDraw())];

  function spotGeom(m: Mapping, s: HealSpot): { d: Point; src: Point; rd: number; rs: number; knob: Point } {
    const d = m.fromSource(s.x, s.y);
    const src = m.fromSource(s.sx, s.sy);
    const rd = m.radiusPx(s.x, s.y, s.radius);
    const rs = m.radiusPx(s.sx, s.sy, s.radius);
    return { d, src, rd, rs, knob: { x: d.x + rd * Math.SQRT1_2, y: d.y + rd * Math.SQRT1_2 } };
  }

  type Hit = { kind: 'dest' | 'src' | 'radius'; idx: number } | { kind: 'removal'; id: string } | null;
  function hitTest(m: Mapping, p: Point, e: PointerEvent | null): Hit {
    const cur = params();
    if (!cur) return null;
    const tol = hitRadius(e);
    const spots = cur.retouch.spots;
    const si = spots.findIndex((s) => s.id === selectedSpot);
    if (si >= 0) {
      const g = spotGeom(m, spots[si]);
      if (dist(p, g.knob) <= tol) return { kind: 'radius', idx: si };
      if (dist(p, g.src) <= Math.max(tol, g.rs)) return { kind: 'src', idx: si };
    }
    for (let i = spots.length - 1; i >= 0; i--) {
      const g = spotGeom(m, spots[i]);
      if (dist(p, g.d) <= Math.max(tol, g.rd)) return { kind: 'dest', idx: i };
    }
    for (const r of cur.retouch.removals) {
      const c = m.fromSource(r.bbox.x + r.bbox.w / 2, r.bbox.y + r.bbox.h / 2);
      if (dist(p, c) <= tol) return { kind: 'removal', id: r.id };
    }
    return null;
  }

  async function addSpot(s: Point): Promise<void> {
    const doc = ctx.doc.value;
    if (!doc) return;
    const kind = ctx.retouchTool.value;
    if (kind !== 'heal' && kind !== 'clone' && kind !== 'content-aware') return;
    const b = ctx.retouchBrush.value;
    const radius = Math.min(0.25, Math.max(0.002, b.size));
    const W = doc.source.width;
    const H = doc.source.height;
    let src = fallbackSource(s.x, s.y, radius, W, H);
    const api = await loadInpaint();
    if (api) {
      try {
        const found = api.findHealSource(doc.analysisProxy, { x: s.x, y: s.y, radius });
        if (isFinitePoint(found)) src = found;
      } catch (err) {
        console.error(err);
      }
    }
    if (disposed || ctx.doc.value !== doc) return;
    const spot: HealSpot = { id: ctx.newId('spot'), kind, x: s.x, y: s.y, sx: src.x, sy: src.y, radius, feather: b.feather, opacity: b.opacity };
    doc.store.update(kind === 'clone' ? 'Clone Spot' : kind === 'heal' ? 'Heal Spot' : 'Content-Aware Spot', (d) => void d.retouch.spots.push(spot), { coalesceKey: null });
    selectedSpot = spot.id;
    selectedRemoval = null;
    host.requestDraw();
  }

  async function runRemoval(cap: StrokeCapture, trail: Point[]): Promise<void> {
    const doc = ctx.doc.value;
    const kind = ctx.retouchTool.value;
    if (!doc || (kind !== 'ai-remove' && kind !== 'generative')) return;
    const b = ctx.retouchBrush.value;
    const strokes: BrushStroke[] = [{ points: cap.points, size: b.size, feather: b.feather, flow: 100, density: 100, erase: false }];
    const entry = { trail, size: b.size, s: cap.points[0] };
    pending.push(entry);
    host.requestDraw();
    const label = kind === 'generative' ? 'Generative fill (classical PatchMatch)…' : 'Removing (PatchMatch)…';
    ctx.busy.set({ active: true, label, progress: 0 });
    try {
      const api = await loadInpaint();
      if (!api) throw new Error('Inpainting module unavailable');
      let src: PixelBuffer = doc.source;
      if (Math.max(src.width, src.height) > 2048) {
        const io = await import('@/editor/io');
        src = io.downscale(src, 2048);
      }
      const { patch, pixels } = await api.createRemovalPatch(src, strokes, kind, {
        onProgress: (f) => ctx.busy.set({ active: true, label, progress: Math.max(0, Math.min(1, f)) }),
        idFactory: () => ctx.newId('patch'),
      });
      if (ctx.doc.value !== doc) return;
      ctx.patchStore.set(patch.patchKey, pixels);
      doc.store.update(kind === 'generative' ? 'Generative Remove' : 'Remove', (d) => void d.retouch.removals.push(patch as RemovalPatch), { coalesceKey: null });
      selectedRemoval = patch.id;
      selectedSpot = null;
    } catch (err) {
      console.error(err);
      ctx.toast(`Remove failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      ctx.busy.set({ active: false });
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      host.requestDraw();
    }
  }

  function setSpot(idx: number, spot: HealSpot, label: string): void {
    store()?.set(`retouch.spots.${idx}`, spot, { label });
  }

  function deleteSelected(): boolean {
    const st = store();
    const cur = params();
    if (!st || !cur) return false;
    if (selectedSpot) {
      const i = cur.retouch.spots.findIndex((s) => s.id === selectedSpot);
      if (i < 0) return false;
      st.update('Delete Spot', (d) => void d.retouch.spots.splice(i, 1), { coalesceKey: null });
      selectedSpot = null;
      host.requestDraw();
      return true;
    }
    if (selectedRemoval) {
      const i = cur.retouch.removals.findIndex((r) => r.id === selectedRemoval);
      if (i < 0) return false;
      // The patch pixels stay in ctx.patchStore: an undo can bring the patch back.
      st.update('Delete Removal', (d) => void d.retouch.removals.splice(i, 1), { coalesceKey: null });
      selectedRemoval = null;
      host.requestDraw();
      return true;
    }
    return false;
  }

  const tool: ViewerTool = {
    name: 'heal',

    onPointerDown(e, p) {
      const m = host.mapping();
      if (!m || e.button !== 0) return false;
      const hit = hitTest(m, p, e);
      const cur = params();
      if (hit && cur) {
        if (hit.kind === 'removal') {
          drag = { kind: 'select-removal', id: hit.id };
          return true;
        }
        const spot = cur.retouch.spots[hit.idx];
        selectedSpot = spot.id;
        selectedRemoval = null;
        store()?.beginGesture(hit.kind === 'radius' ? 'Spot Size' : 'Move Spot');
        drag = hit.kind === 'radius' ? { kind: 'radius', idx: hit.idx, spot0: spot } : { kind: hit.kind, idx: hit.idx, s0: m.toSource(p.x, p.y), spot0: spot };
        host.requestDraw();
        return true;
      }
      const s = m.toSource(p.x, p.y);
      if (!isFinitePoint(s) || s.x < 0 || s.y < 0 || s.x > 1 || s.y > 1) return false;
      if (isRemoval()) {
        const cap = startStroke(m, p, e);
        if (!cap) return false;
        drag = { kind: 'paint', cap };
        return true;
      }
      drag = { kind: 'new', p0: p, s0: s, moved: false };
      return true;
    },

    onPointerMove(e, p) {
      const m = host.mapping();
      const d = drag;
      if (!m || !d) return;
      hover = p;
      if (d.kind === 'new') {
        if (dist(p, d.p0) > 6) d.moved = true;
      } else if (d.kind === 'paint') {
        const s = d.cap.points[0];
        const r = m.radiusPx(s.x, s.y, ctx.retouchBrush.value.size);
        extendStroke(d.cap, m, e, host.local, Math.max(1.5, r * 0.12));
      } else if (d.kind === 'dest' || d.kind === 'src') {
        const s = m.toSource(p.x, p.y);
        if (!isFinitePoint(s)) return;
        const dx = s.x - d.s0.x;
        const dy = s.y - d.s0.y;
        const sp = d.spot0;
        const next = d.kind === 'dest' ? { ...sp, x: sp.x + dx, y: sp.y + dy } : { ...sp, sx: sp.sx + dx, sy: sp.sy + dy };
        setSpot(d.idx, next, 'Move Spot');
      } else if (d.kind === 'radius') {
        const sp = d.spot0;
        const c = m.fromSource(sp.x, sp.y);
        const r = m.radiusFromPx(c.x, c.y, dist(p, c));
        setSpot(d.idx, { ...sp, radius: Math.min(0.25, Math.max(0.002, r)) }, 'Spot Size');
      }
      host.requestDraw();
    },

    onPointerUp() {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.kind === 'new') {
        if (!d.moved) void addSpot(d.s0);
        else {
          selectedSpot = null;
          selectedRemoval = null;
        }
      } else if (d.kind === 'paint') void runRemoval(d.cap, d.cap.trail);
      else if (d.kind === 'select-removal') {
        selectedRemoval = d.id;
        selectedSpot = null;
      } else store()?.endGesture();
      host.requestDraw();
    },

    onCancel() {
      const d = drag;
      drag = null;
      if (d && (d.kind === 'dest' || d.kind === 'src' || d.kind === 'radius')) store()?.endGesture();
      host.requestDraw();
    },

    onHover(p) {
      hover = p;
      host.requestDraw();
    },

    cursor(p, e) {
      const m = host.mapping();
      if (!m) return 'default';
      const hit = hitTest(m, p, e);
      if (hit?.kind === 'radius') return 'nwse-resize';
      if (hit?.kind === 'dest' || hit?.kind === 'src') return 'move';
      if (hit?.kind === 'removal') return 'pointer';
      return 'none';
    },

    command(cmd: ToolCommand) {
      switch (cmd) {
        case 'delete':
          return deleteSelected();
        case 'size-up':
        case 'size-down': {
          const f = cmd === 'size-up' ? 1.15 : 1 / 1.15;
          const b = ctx.retouchBrush.value;
          ctx.retouchBrush.set({ ...b, size: Math.min(0.25, Math.max(0.002, b.size * f)) });
          const cur = params();
          const i = cur ? cur.retouch.spots.findIndex((s) => s.id === selectedSpot) : -1;
          if (cur && i >= 0) {
            const sp = cur.retouch.spots[i];
            setSpot(i, { ...sp, radius: Math.min(0.25, Math.max(0.002, sp.radius * f)) }, 'Spot Size');
          }
          host.requestDraw();
          return true;
        }
        case 'feather-up':
        case 'feather-down': {
          const b = ctx.retouchBrush.value;
          ctx.retouchBrush.set({ ...b, feather: Math.min(100, Math.max(0, b.feather + (cmd === 'feather-up' ? 10 : -10))) });
          return true;
        }
        case 'escape':
          if (selectedSpot || selectedRemoval) {
            selectedSpot = null;
            selectedRemoval = null;
            host.requestDraw();
          } else ctx.tool.set('edit');
          return true;
        case 'enter':
          ctx.tool.set('edit');
          return true;
        default:
          return false;
      }
    },

    draw(g, m) {
      const cur = shownParams(ctx);
      if (!cur) return;
      for (const s of cur.retouch.spots) {
        const sel = s.id === selectedSpot;
        const geo = spotGeom(m, s);
        ring(g, geo.d, geo.rd, sel ? 'k-vo-spot is-selected' : 'k-vo-spot');
        if (sel) {
          ring(g, geo.src, geo.rs, 'k-vo-spot k-vo-spot--src');
          const len = dist(geo.src, geo.d);
          if (len > geo.rd + geo.rs + 4) {
            const ux = (geo.d.x - geo.src.x) / len;
            const uy = (geo.d.y - geo.src.y) / len;
            const a = { x: geo.src.x + ux * geo.rs, y: geo.src.y + uy * geo.rs };
            const b = { x: geo.d.x - ux * geo.rd, y: geo.d.y - uy * geo.rd };
            line(g, a, b, 'k-vo-spot');
            arrow(g, a, b, 7, 'k-vo-spot');
          }
          knob(g, geo.knob, 4);
        }
      }
      for (const r of cur.retouch.removals) {
        const c = m.fromSource(r.bbox.x + r.bbox.w / 2, r.bbox.y + r.bbox.h / 2);
        knob(g, c, 4.5, r.id === selectedRemoval ? 'k-vo-pin is-selected' : 'k-vo-pin');
      }
      for (const pnd of pending) {
        drawTrail(g, pnd.trail, 2 * m.radiusPx(pnd.s.x, pnd.s.y, pnd.size), 'k-vo-trail k-vo-trail--pending');
      }
      if (drag?.kind === 'paint') {
        const s = drag.cap.points[0];
        drawTrail(g, drag.cap.trail, 2 * m.radiusPx(s.x, s.y, ctx.retouchBrush.value.size), 'k-vo-trail');
      }
      if (hover && (!drag || drag.kind === 'paint' || drag.kind === 'new')) {
        const hit = drag ? null : hitTest(m, hover, null);
        if (!hit) drawBrushRing(g, m, hover, ctx.retouchBrush.value.size, isRemoval() ? ctx.retouchBrush.value.feather : 0, false);
      }
    },

    dispose() {
      disposed = true;
      if (drag) tool.onCancel?.();
      for (const off of offs) off();
    },
  };
  return tool;
}
