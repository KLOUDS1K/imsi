/**
 * Crop & straighten tool (ctx.tool === 'crop').
 *
 * The shell renders the UNCROPPED frame while this tool is active, so the
 * DisplayTransform maps canvas px ↔ frame-normalized coords and the crop rect
 * (params.crop.x/y/w/h, frame-normalized) is an axis-aligned canvas rect.
 *
 * Gestures (each is one history step via beginGesture/endGesture):
 * - corner/edge handles resize (aspect lock from params.crop.aspect),
 * - drag inside moves, drag outside rotates (image follows the pointer),
 * - straighten: Ctrl/⌘-drag, or the Straighten toggle, draws a level line.
 * With `constrainToImage` every result is limited to valid image data using
 * geometry.isCropValid / maxValidCrop.
 */
import type { AppContext } from '@/app/context';
import { aspectRatioValue, frameSize, isCropValid, maxValidCrop } from '@/editor/engine/geometry';
import type { CropParams, EditParams, Point, Rect } from '@/editor/types';
import type { Signal } from '@/ui/signal';
import {
  CROP_HANDLES,
  angleBetween,
  clampAngle,
  conformToRatio,
  handleDir,
  handlePoint,
  limitToValid,
  moveCrop,
  normalizedRatio,
  rectsClose,
  resizeCrop,
  shrinkToValid,
  straightenDelta,
  swapRectOrientation,
  swappedAspect,
  type CropHandle,
} from './crop-math';
import { OVERLAY_CYCLE, gridPath, overlayPath } from './crop-guides';
import { fill, label, line, pathD, stroke } from './draw';
import { dist, distToSegment, hitRadius, type Mapping, type ToolCommand, type ViewerHost, type ViewerTool } from './host';

type Drag =
  | { kind: 'resize'; handle: CropHandle; start: Rect; valid: boolean }
  | { kind: 'move'; start: Rect; p0: Point; valid: boolean }
  | { kind: 'rotate'; start: Rect; angle0: number; v0: Point; c: Point; last: number }
  | { kind: 'straighten'; a: Point; b: Point };

const CURSORS: Record<CropHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export interface CropToolOptions {
  /** Straighten-line mode (toggle in the viewer bar). */
  straighten: Signal<boolean>;
  /** Golden spiral orientation 0..7 (Shift+O). */
  spiral: Signal<number>;
}

export function createCropTool(host: ViewerHost, opts: CropToolOptions): ViewerTool {
  const ctx: AppContext = host.ctx;
  const doc = ctx.doc.value;
  const store = doc?.store;
  const entryCrop: CropParams | null = store ? structuredClone(store.params.crop) : null;
  let drag: Drag | null = null;
  /** Rect the user last chose; rotation/angle changes shrink from it (and regrow back). */
  let baseRect: Rect | null = store ? rectOf(store.params.crop) : null;
  let hoverRotate = false;
  let disposed = false;

  function rectOf(c: CropParams): Rect {
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  const params = (): EditParams | null => ctx.doc.value?.store.params ?? null;
  const src = (): { w: number; h: number } | null => {
    const s = ctx.doc.value?.source;
    return s ? { w: s.width, h: s.height } : null;
  };
  const frame = (p: EditParams): { width: number; height: number } => {
    const s = src();
    return s ? frameSize(p, s.w, s.h) : { width: 1, height: 1 };
  };
  const ratioFor = (p: EditParams): number | null => {
    const s = src();
    if (!s) return null;
    const f = frame(p);
    return normalizedRatio(aspectRatioValue(p, s.w, s.h), f.width, f.height);
  };
  const validFn = (p: EditParams): ((r: Rect) => boolean) => {
    const s = src();
    if (!s || !p.crop.constrainToImage) return () => true;
    return (r) => isCropValid(p, s.w, s.h, r);
  };

  /** Constrained rect for `p` (angle/transform changed) starting from `r`. */
  function constrained(p: EditParams, r: Rect): Rect {
    const s = src();
    if (!s || !p.crop.constrainToImage) return r;
    const shrunk = shrinkToValid(r, validFn(p));
    if (shrunk) return shrunk;
    return maxValidCrop(p, s.w, s.h, aspectRatioValue(p, s.w, s.h));
  }

  function writeCrop(patch: Partial<CropParams>, label: string, coalesceKey?: string | null): void {
    const st = ctx.doc.value?.store;
    if (!st) return;
    st.set('crop', { ...st.params.crop, ...patch }, { label, coalesceKey });
  }

  /* ---- keep the rect conformant when the panel changes aspect / angle ---- */
  let prev = params();
  let pending = false;
  const unsub = store?.subscribe((p, info) => {
    const before = prev;
    prev = p;
    if (drag || !before || info.source === 'undo' || info.source === 'redo' || info.source === 'history') {
      if (!drag) baseRect = rectOf(p.crop);
      return;
    }
    const aspectChanged = before.crop.aspect !== p.crop.aspect || before.crop.customAspect.join() !== p.crop.customAspect.join();
    const geomChanged =
      before.crop.angle !== p.crop.angle ||
      before.transform !== p.transform ||
      before.crop.orientation !== p.crop.orientation ||
      before.crop.flipH !== p.crop.flipH ||
      before.crop.flipV !== p.crop.flipV ||
      before.lens !== p.lens ||
      before.crop.constrainToImage !== p.crop.constrainToImage;
    const rectChanged = !rectsClose(rectOf(before.crop), rectOf(p.crop));
    if (rectChanged && !aspectChanged && !geomChanged) baseRect = rectOf(p.crop);
    if (!aspectChanged && !geomChanged) return;
    // Defer: never write to the store from inside its own notification.
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      const cur = params();
      if (!cur) return;
      let r = aspectChanged ? rectOf(cur.crop) : (baseRect ?? rectOf(cur.crop));
      const ratio = ratioFor(cur);
      if (ratio && Math.abs(r.w / r.h / ratio - 1) > 0.004) r = conformToRatio(r, ratio);
      if (aspectChanged) baseRect = r;
      r = constrained(cur, r);
      if (rectsClose(r, rectOf(cur.crop))) return;
      const st = ctx.doc.value?.store;
      if (!st) return;
      // Merge into the entry that caused it (same coalesce key as the panel's set()).
      const tipLabel = st.history[st.historyIndex]?.label ?? 'Crop';
      writeCrop(r, tipLabel, aspectChanged ? 'crop.aspect' : 'crop.angle');
    });
  });

  /* -------------------------------- hit testing -------------------------------- */

  function canvasRect(m: Mapping, c: CropParams | Rect): Rect {
    const a = m.fromOutput(c.x, c.y);
    const b = m.fromOutput(c.x + c.w, c.y + c.h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  type Hit = { kind: 'handle'; handle: CropHandle } | { kind: 'inside' } | { kind: 'outside' };
  function hitTest(m: Mapping, p: Point, e: PointerEvent | null): Hit {
    const cur = params();
    if (!cur) return { kind: 'outside' };
    const r = canvasRect(m, cur.crop);
    const tol = hitRadius(e) + 2;
    for (const h of CROP_HANDLES) {
      const { dx, dy } = handleDir(h);
      if (dx && dy && dist(p, handlePoint(r, h)) <= tol + 4) return { kind: 'handle', handle: h };
    }
    const tl = { x: r.x, y: r.y };
    const tr = { x: r.x + r.w, y: r.y };
    const bl = { x: r.x, y: r.y + r.h };
    const br = { x: r.x + r.w, y: r.y + r.h };
    if (distToSegment(p, tl, tr) <= tol) return { kind: 'handle', handle: 'n' };
    if (distToSegment(p, bl, br) <= tol) return { kind: 'handle', handle: 's' };
    if (distToSegment(p, tl, bl) <= tol) return { kind: 'handle', handle: 'w' };
    if (distToSegment(p, tr, br) <= tol) return { kind: 'handle', handle: 'e' };
    if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return { kind: 'inside' };
    return { kind: 'outside' };
  }

  /* -------------------------------- gestures -------------------------------- */

  function begin(label: string): void {
    ctx.doc.value?.store.beginGesture(label);
  }
  function end(): void {
    ctx.doc.value?.store.endGesture();
  }

  const tool: ViewerTool = {
    name: 'crop',

    onPointerDown(e, p) {
      const m = host.mapping();
      const cur = params();
      if (!m || !cur || e.button !== 0) return false;
      if (opts.straighten.value || e.ctrlKey || e.metaKey) {
        drag = { kind: 'straighten', a: p, b: p };
        host.requestDraw();
        return true;
      }
      const hit = hitTest(m, p, e);
      const start = rectOf(cur.crop);
      const valid = validFn(cur)(start);
      if (hit.kind === 'handle') {
        drag = { kind: 'resize', handle: hit.handle, start, valid };
        begin('Crop');
      } else if (hit.kind === 'inside') {
        drag = { kind: 'move', start, p0: m.toOutput(p.x, p.y), valid };
        begin('Crop');
      } else {
        const r = canvasRect(m, cur.crop);
        const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        drag = { kind: 'rotate', start: baseRect ?? start, angle0: cur.crop.angle, v0: { x: p.x - c.x, y: p.y - c.y }, c, last: cur.crop.angle };
        begin('Straighten');
      }
      host.requestDraw();
      return true;
    },

    onPointerMove(e, p) {
      const m = host.mapping();
      const cur = params();
      if (!drag || !m || !cur) return;
      if (drag.kind === 'straighten') {
        drag.b = p;
        host.requestDraw();
        return;
      }
      if (drag.kind === 'resize') {
        const q = m.toOutput(p.x, p.y);
        // Shift temporarily frees a locked aspect (and locks a free one to the current rect).
        let ratio = ratioFor(cur);
        if (e.shiftKey) ratio = ratio ? null : drag.start.w / drag.start.h;
        let r = resizeCrop(drag.start, drag.handle, q, ratio);
        if (drag.valid) r = limitToValid(drag.start, r, validFn(cur));
        baseRect = r;
        writeCrop(r, 'Crop');
      } else if (drag.kind === 'move') {
        const q = m.toOutput(p.x, p.y);
        let r = moveCrop(drag.start, q.x - drag.p0.x, q.y - drag.p0.y);
        if (drag.valid) {
          const valid = validFn(cur);
          if (!valid(r)) {
            // Slide along the blocking edge: x first, then y from there.
            const rx = limitToValid(drag.start, { ...drag.start, x: r.x }, valid);
            r = limitToValid(rx, { ...rx, y: r.y }, valid);
          }
        }
        baseRect = r;
        writeCrop(r, 'Crop');
      } else {
        const v = { x: p.x - drag.c.x, y: p.y - drag.c.y };
        if (Math.hypot(v.x, v.y) < 4) return;
        // Incremental so a drag past ±180° keeps working.
        const a = clampAngle(drag.angle0 + angleBetween(drag.v0.x, drag.v0.y, v.x, v.y));
        if (a === drag.last) return;
        drag.last = a;
        const next: EditParams = { ...cur, crop: { ...cur.crop, angle: a } };
        const r = constrained(next, drag.start);
        writeCrop({ ...r, angle: a }, 'Straighten');
      }
      host.requestDraw();
    },

    onPointerUp() {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.kind === 'straighten') {
        const len = dist(d.a, d.b);
        const cur = params();
        if (len > 12 && cur) {
          const a = clampAngle(cur.crop.angle + straightenDelta(d.b.x - d.a.x, d.b.y - d.a.y));
          const next: EditParams = { ...cur, crop: { ...cur.crop, angle: a } };
          const r = constrained(next, baseRect ?? rectOf(cur.crop));
          writeCrop({ ...r, angle: a }, 'Straighten', null);
          opts.straighten.set(false);
        }
      } else end();
      host.requestDraw();
    },

    onCancel() {
      if (drag && drag.kind !== 'straighten') end();
      drag = null;
      host.requestDraw();
    },

    onHover(p, e) {
      const m = host.mapping();
      const was = hoverRotate;
      hoverRotate = !!(p && m && !opts.straighten.value && hitTest(m, p, e).kind === 'outside');
      if (was !== hoverRotate) host.requestDraw();
    },

    onDoubleClick(p) {
      const m = host.mapping();
      if (m && hitTest(m, p, null).kind === 'inside') {
        ctx.tool.set('edit');
        return true;
      }
      return false;
    },

    cursor(p, e) {
      if (opts.straighten.value || e?.ctrlKey || e?.metaKey) return 'crosshair';
      const m = host.mapping();
      if (!m) return 'default';
      const hit = hitTest(m, p, e);
      if (hit.kind === 'handle') return CURSORS[hit.handle];
      return hit.kind === 'inside' ? 'move' : 'alias';
    },

    command(cmd: ToolCommand) {
      const st = ctx.doc.value?.store;
      const cur = params();
      if (!st || !cur) return false;
      switch (cmd) {
        case 'enter':
          ctx.tool.set('edit');
          return true;
        case 'escape':
          if (opts.straighten.value) {
            opts.straighten.set(false);
            return true;
          }
          if (entryCrop && JSON.stringify(entryCrop) !== JSON.stringify(cur.crop)) {
            st.set('crop', entryCrop, { label: 'Cancel Crop', coalesceKey: null });
          }
          ctx.tool.set('edit');
          return true;
        case 'swap-aspect': {
          const f = frame(cur);
          const asp = swappedAspect(cur.crop, f.width, f.height);
          let r = swapRectOrientation(rectOf(cur.crop), f.width, f.height);
          const next: EditParams = { ...cur, crop: { ...cur.crop, ...asp } };
          const ratio = ratioFor(next);
          if (ratio) r = conformToRatio(r, ratio);
          r = constrained(next, r);
          baseRect = r;
          st.set('crop', { ...cur.crop, ...asp, ...r }, { label: 'Crop Orientation', coalesceKey: null });
          return true;
        }
        case 'overlay-cycle': {
          const i = OVERLAY_CYCLE.indexOf(cur.crop.overlay);
          st.set('crop.overlay', OVERLAY_CYCLE[(i + 1) % OVERLAY_CYCLE.length], { label: 'Crop Overlay' });
          return true;
        }
        case 'overlay-orientation':
          opts.spiral.set((opts.spiral.value + 1) % 8);
          host.requestDraw();
          return true;
        default:
          return false;
      }
    },

    draw(g, m) {
      const cur = params();
      if (!cur) return;
      const r = canvasRect(m, cur.crop);
      const vw = m.t.viewportWidth;
      const vh = m.t.viewportHeight;
      // Dim everything outside the crop.
      fill(g, `M-2 -2H${vw + 2}V${vh + 2}H-2Z` + pathD([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], true), 'k-vo-dim');
      const rotating = drag?.kind === 'rotate';
      if (rotating) stroke(g, gridPath(r, 22), 'k-vo-guide k-vo-guide--fine');
      else if (cur.crop.overlay !== 'none') stroke(g, overlayPath(cur.crop.overlay, r, opts.spiral.value), 'k-vo-guide');
      stroke(g, pathD([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], true), 'k-vo-border');
      // Lightroom-style corner brackets and edge bars.
      const L = Math.max(6, Math.min(18, Math.min(Math.abs(r.w), Math.abs(r.h)) / 4));
      for (const h of CROP_HANDLES) {
        const { dx, dy } = handleDir(h);
        const c = handlePoint(r, h);
        if (dx && dy) {
          stroke(g, pathD([{ x: c.x - dx * L, y: c.y }, c, { x: c.x, y: c.y - dy * L }]), 'k-vo-handle');
        } else if (dx) line(g, { x: c.x, y: c.y - L / 2 }, { x: c.x, y: c.y + L / 2 }, 'k-vo-handle');
        else line(g, { x: c.x - L / 2, y: c.y }, { x: c.x + L / 2, y: c.y }, 'k-vo-handle');
      }
      if (rotating || hoverRotate) {
        const a = cur.crop.angle;
        label(g, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(a).toFixed(2)}°`, rotating ? 'k-vo-text--big' : 'k-vo-text--faint');
      }
      if (drag?.kind === 'straighten' && dist(drag.a, drag.b) > 2) {
        line(g, drag.a, drag.b, 'k-vo-level');
        const d = straightenDelta(drag.b.x - drag.a.x, drag.b.y - drag.a.y);
        label(g, { x: (drag.a.x + drag.b.x) / 2, y: (drag.a.y + drag.b.y) / 2 - 12 }, `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(2)}°`);
      }
    },

    dispose() {
      disposed = true;
      if (drag && drag.kind !== 'straighten') end();
      drag = null;
      unsub?.();
    },
  };
  return tool;
}
