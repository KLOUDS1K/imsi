/**
 * Crop tool panel. Edits params.crop (the viewer draws the on-canvas frame):
 * aspect presets + custom ratio, lock, swap orientation, straighten (+ Auto),
 * rotate ±90°, flips (exact mirror of the output), overlay, constrain, reset.
 *
 * The operations live in `createCropOps(ctx)` so keyboard commands share them.
 */
import type { AppContext } from '@/app/context';
import { detectLevelAngle } from '@/editor/analysis';
import type { EditorStoreApi } from '@/editor/contracts';
import { aspectRatioValue, frameSize, isCropValid, maxValidCrop } from '@/editor/engine/geometry';
import type { AspectPreset, CropOverlay, CropParams, EditParams, Rect } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { clamp, createButton, createIconButton, createNumberInput, createSelect, createToggle, type IconName } from '@/ui/kit';
import { type DocBinder, paramSlider, resetPaths } from './binding';
import { guarded } from './util';

export const ASPECTS: { value: AspectPreset; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'free', label: 'Free' },
  { value: '1:1', label: '1 : 1' },
  { value: '3:2', label: '3 : 2' },
  { value: '4:3', label: '4 : 3' },
  { value: '5:4', label: '5 : 4' },
  { value: '16:9', label: '16 : 9' },
  { value: '4:5', label: '4 : 5' },
  { value: '2:3', label: '2 : 3' },
  { value: 'custom', label: 'Custom' },
];
export const OVERLAYS: { value: CropOverlay; label: string }[] = [
  { value: 'thirds', label: 'Rule of Thirds' },
  { value: 'golden-ratio', label: 'Golden Ratio' },
  { value: 'golden-spiral', label: 'Golden Spiral' },
  { value: 'grid', label: 'Grid' },
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'none', label: 'None' },
];
const CROP_RESET = ['crop.x', 'crop.y', 'crop.w', 'crop.h', 'crop.angle', 'crop.aspect', 'crop.customAspect', 'crop.orientation', 'crop.flipH', 'crop.flipV'];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Reduce a ratio to small integers ([153, 100] → [153, 100], [150, 100] → [3, 2]). */
function ratioOf(r: number): [number, number] {
  const w = Math.max(1, Math.round(r * 100));
  const g = gcd(w, 100) || 1;
  return [w / g, 100 / g];
}

/** Rotate a frame-normalized rect with the frame (quarter turn). */
export function rotateRect(r: Rect, cw: boolean): Rect {
  return cw ? { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w } : { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
}

/** The same shape rotated by 90°: 3:2 ↔ 2:3, 4:3 → custom 3:4 … */
export function swappedAspect(c: CropParams, frameAspect: number): Pick<CropParams, 'aspect' | 'customAspect'> {
  const pairs: Partial<Record<AspectPreset, AspectPreset>> = { '3:2': '2:3', '2:3': '3:2', '5:4': '4:5', '4:5': '5:4', '1:1': '1:1', free: 'free' };
  const direct = pairs[c.aspect];
  if (direct) return { aspect: direct, customAspect: c.customAspect };
  if (c.aspect === 'custom') return { aspect: 'custom', customAspect: [c.customAspect[1], c.customAspect[0]] };
  if (c.aspect === '4:3') return { aspect: 'custom', customAspect: [3, 4] };
  if (c.aspect === '16:9') return { aspect: 'custom', customAspect: [9, 16] };
  // 'original': freeze the inverse of the frame ratio.
  return { aspect: 'custom', customAspect: ratioOf(1 / frameAspect) };
}

/** Largest rect of pixel aspect `a` inside the frame, centred on the current crop centre. */
function fitAspect(a: number | null, cur: Rect, fw: number, fh: number): Rect {
  if (a === null) return cur;
  const an = (a * fh) / fw; // normalized w/h
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let w = 1;
  let hh = w / an;
  if (hh > 1) {
    hh = 1;
    w = an;
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - hh / 2, 0, 1 - hh), w, h: hh };
}

/**
 * Keep the crop on valid image data: shrink the rect about its centre
 * (bisection) until it is valid; fall back to the maximal valid crop.
 */
export function constrainCrop(params: EditParams, srcW: number, srcH: number, rect: Rect): Rect {
  if (!params.crop.constrainToImage || isCropValid(params, srcW, srcH, rect)) return rect;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const at = (s: number): Rect => ({ x: cx - (rect.w * s) / 2, y: cy - (rect.h * s) / 2, w: rect.w * s, h: rect.h * s });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (isCropValid(params, srcW, srcH, at(mid))) lo = mid;
    else hi = mid;
  }
  if (lo > 0.05) return at(lo);
  return maxValidCrop(params, srcW, srcH, aspectRatioValue(params, srcW, srcH));
}

export interface CropOps {
  setAspect(aspect: AspectPreset, custom?: [number, number]): void;
  toggleLock(locked?: boolean): void;
  swapOrientation(): void;
  rotate(cwVisual: boolean): void;
  flip(axis: 'h' | 'v'): void;
  autoStraighten(): void;
  cycleOverlay(): void;
}

/** Crop operations on the current document (shared by the panel and keyboard commands). */
export function createCropOps(ctx: AppContext): CropOps {
  const cur = (): { store: EditorStoreApi; srcW: number; srcH: number } | null => {
    const doc = ctx.doc.value;
    return doc ? { store: doc.store, srcW: doc.source.width, srcH: doc.source.height } : null;
  };

  /** Merge a crop patch (and extra edits) in one history step, then fit the constraint. */
  function writeCrop(label: string, patch: (c: CropParams, p: EditParams) => Partial<CropParams>, extra?: (p: EditParams) => void): void {
    const c = cur();
    if (!c) return;
    c.store.update(
      label,
      (p) => {
        Object.assign(p.crop, patch(p.crop, p));
        extra?.(p);
        Object.assign(p.crop, constrainCrop(p, c.srcW, c.srcH, { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h }));
      },
      { coalesceKey: null },
    );
  }

  const ops: CropOps = {
    setAspect(aspect, custom) {
      const c = cur();
      const label = ASPECTS.find((a) => a.value === aspect)?.label.replace(/ /g, '') ?? aspect;
      writeCrop(`Crop Aspect: ${label}`, (crop, p) => {
        const customAspect = custom ?? crop.customAspect;
        if (!c || aspect === 'free') return { aspect, customAspect };
        const probe = { ...p, crop: { ...crop, aspect, customAspect } };
        const fs = frameSize(probe, c.srcW, c.srcH);
        return { aspect, customAspect, ...fitAspect(aspectRatioValue(probe, c.srcW, c.srcH), crop, fs.width, fs.height) };
      });
    },
    toggleLock(locked) {
      const c = cur();
      if (!c) return;
      const p = c.store.params;
      const lock = locked ?? p.crop.aspect === 'free';
      if (!lock) {
        c.store.set('crop.aspect', 'free', { label: 'Crop Aspect: Free', coalesceKey: null });
        return;
      }
      // Lock the ratio currently on screen (in pixels).
      const fs = frameSize(p, c.srcW, c.srcH);
      const ratio = ratioOf((p.crop.w * fs.width) / Math.max(1e-6, p.crop.h * fs.height));
      c.store.update(
        'Crop Aspect: Locked',
        (q) => {
          q.crop.aspect = 'custom';
          q.crop.customAspect = ratio;
        },
        { coalesceKey: null },
      );
    },
    swapOrientation() {
      const c = cur();
      if (!c) return;
      writeCrop('Crop: Swap Orientation', (crop, p) => {
        const fs = frameSize(p, c.srcW, c.srcH);
        const next = swappedAspect(crop, fs.width / fs.height);
        // Swap the pixel width/height (normalized units differ per axis), then fit inside the frame.
        let w = (crop.h * fs.height) / fs.width;
        let hh = (crop.w * fs.width) / fs.height;
        const s = Math.min(1, 1 / w, 1 / hh);
        w *= s;
        hh *= s;
        const cx = crop.x + crop.w / 2;
        const cy = crop.y + crop.h / 2;
        return { ...next, w, h: hh, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - hh / 2, 0, 1 - hh) };
      });
    },
    rotate(cwVisual) {
      const c = cur();
      if (!c) return;
      writeCrop(cwVisual ? 'Rotate Right' : 'Rotate Left', (crop, p) => {
        // With exactly one flip active the oriented space is mirrored, so an
        // orientation step turns the output the other way.
        const cw = crop.flipH !== crop.flipV ? !cwVisual : cwVisual;
        const orientation = ((crop.orientation + (cw ? 90 : 270)) % 360) as CropParams['orientation'];
        const fs = frameSize(p, c.srcW, c.srcH);
        const asp = crop.aspect === 'original' ? { aspect: crop.aspect, customAspect: crop.customAspect } : swappedAspect(crop, fs.width / fs.height);
        return { orientation, ...rotateRect(crop, cwVisual), ...asp };
      });
    },
    flip(axis) {
      // Exact mirror of the output: toggle the source flip, mirror the rect and
      // negate the geometry terms that change sign under the mirror.
      writeCrop(
        axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical',
        (crop) =>
          axis === 'h'
            ? { flipH: !crop.flipH, x: 1 - (crop.x + crop.w), angle: -crop.angle || 0 }
            : { flipV: !crop.flipV, y: 1 - (crop.y + crop.h), angle: -crop.angle || 0 },
        (p) => {
          const t = p.transform;
          t.rotate = -t.rotate || 0;
          if (axis === 'h') {
            t.horizontal = -t.horizontal || 0;
            t.offsetX = -t.offsetX || 0;
          } else {
            t.vertical = -t.vertical || 0;
            t.offsetY = -t.offsetY || 0;
          }
        },
      );
    },
    autoStraighten() {
      const doc = ctx.doc.value;
      if (!doc) return;
      void guarded(ctx.toast.bind(ctx), 'Auto straighten', () => {
        const r = detectLevelAngle(doc.analysisProxy);
        writeCrop('Auto Straighten', () => ({ angle: clamp(Math.round(r.angle * 100) / 100, -45, 45) }));
        if (r.confidence < 0.25) ctx.toast('No clear horizon found — check the result', 'info');
      });
    },
    cycleOverlay() {
      const c = cur();
      if (!c) return;
      const i = OVERLAYS.findIndex((o) => o.value === c.store.params.crop.overlay);
      const next = OVERLAYS[(i + 1) % OVERLAYS.length];
      c.store.set('crop.overlay', next.value, { label: `Crop Overlay: ${next.label}`, coalesceKey: null });
    },
  };
  return ops;
}

export interface ToolPanel {
  el: HTMLElement;
  dispose(): void;
}

export function createCropPanel(ctx: AppContext, b: DocBinder): ToolPanel {
  const d = new Disposer();
  const ops = createCropOps(ctx);

  /* ---- aspect ---- */
  const chips = ASPECTS.map((a) =>
    h(
      'button',
      { type: 'button', class: 'k-pnl-chip k-pnl-chip--aspect', dataset: { aspect: a.value }, attrs: { 'aria-pressed': 'false' }, onclick: () => ops.setAspect(a.value) },
      a.label,
    ),
  );
  const setCustom = (w: number, hh: number): void => ops.setAspect('custom', [Math.max(1, Math.round(w)), Math.max(1, Math.round(hh))]);
  const customW = createNumberInput({ value: 5, min: 1, max: 100, step: 1, decimals: 0, ariaLabel: 'Custom aspect width', width: '64px', onChange: (v) => setCustom(v, customH.getValue()) });
  const customH = createNumberInput({ value: 7, min: 1, max: 100, step: 1, decimals: 0, ariaLabel: 'Custom aspect height', width: '64px', onChange: (v) => setCustom(customW.getValue(), v) });
  d.add(() => customW.destroy());
  d.add(() => customH.destroy());
  const customRow = h('div', { class: 'k-pnl-row k-pnl-crop__custom' }, h('span', { class: 'k-pnl-row__label' }, 'Ratio'), customW.el, h('span', { class: 'k-muted' }, '×'), customH.el);

  const lock = createIconButton({ icon: 'lock', label: 'Lock aspect ratio', shortcut: 'A', size: 'sm', pressed: true, onToggle: (on) => ops.toggleLock(on) });
  const swap = createIconButton({ icon: 'aspect-ratio', label: 'Swap orientation', shortcut: 'X', size: 'sm', onClick: () => ops.swapOrientation() });
  d.add(() => lock.destroy());
  d.add(() => swap.destroy());

  /* ---- straighten ---- */
  const angle = paramSlider(b, d, 'crop.angle', { label: 'Angle', decimals: 1, ariaLabel: 'Straighten angle' });
  // Keep the crop on valid pixels while straightening (inside the same gesture).
  d.add(
    b.watch(
      ['crop.angle'],
      (p0, info) => {
        const doc = b.doc;
        if (!p0 || !doc || !info || info.source !== 'set' || !info.interactive || !p0.crop.constrainToImage) return;
        // Deferred: writing from inside a store notification would reorder
        // notifications for listeners that have not run yet.
        queueMicrotask(() => {
          if (b.doc !== doc || !doc.store.gestureActive) return;
          const p = doc.store.params;
          const rect = { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h };
          const r = constrainCrop(p, doc.source.width, doc.source.height, rect);
          if (r.x !== rect.x || r.y !== rect.y || r.w !== rect.w || r.h !== rect.h) doc.store.set('crop', { ...p.crop, ...r });
        });
      },
      false,
    ),
  );
  const autoBtn = createButton({ label: 'Auto', size: 'sm', variant: 'ghost', title: 'Auto straighten', onClick: () => ops.autoStraighten() });
  d.add(() => autoBtn.destroy());

  /* ---- rotate / flip ---- */
  const mk = (icon: IconName, label: string, fn: () => void, shortcut?: string) => {
    const btn = createIconButton({ icon, label, size: 'md', shortcut, onClick: fn });
    d.add(() => btn.destroy());
    return btn;
  };
  const rotL = mk('rotate-ccw', 'Rotate left', () => ops.rotate(false), 'Mod+[');
  const rotR = mk('rotate-cw', 'Rotate right', () => ops.rotate(true), 'Mod+]');
  const flipH = mk('flip-h', 'Flip horizontal', () => ops.flip('h'));
  const flipV = mk('flip-v', 'Flip vertical', () => ops.flip('v'));

  /* ---- overlay + constrain ---- */
  const overlay = createSelect<CropOverlay>({
    ariaLabel: 'Crop overlay',
    size: 'sm',
    value: 'thirds',
    options: OVERLAYS,
    onChange: (v) => b.store?.set('crop.overlay', v, { label: `Crop Overlay: ${OVERLAYS.find((o) => o.value === v)?.label}`, coalesceKey: null }),
  });
  d.add(() => overlay.destroy());
  const constrain = createToggle({
    label: 'Constrain to image',
    size: 'sm',
    onChange: (on) => {
      const doc = b.doc;
      if (!doc) return;
      doc.store.update(
        `Constrain to Image ${on ? 'On' : 'Off'}`,
        (p) => {
          p.crop.constrainToImage = on;
          Object.assign(p.crop, constrainCrop(p, doc.source.width, doc.source.height, { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h }));
        },
        { coalesceKey: null },
      );
    },
  });
  d.add(() => constrain.destroy());

  const reset = createButton({ label: 'Reset', size: 'sm', icon: 'reset', onClick: () => resetPaths(b, CROP_RESET, 'Reset Crop') });
  const done = createButton({ label: 'Done', size: 'sm', variant: 'primary', onClick: () => ctx.tool.set('edit') });
  d.add(() => reset.destroy());
  d.add(() => done.destroy());

  const sub = (title: string, actions: HTMLElement[], ...body: HTMLElement[]): HTMLElement =>
    h(
      'div',
      { class: 'k-pnl-sub' },
      h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, title), h('span', { class: 'k-pnl-sub__spacer' }), ...actions),
      ...body,
    );

  const el = h(
    'div',
    { class: 'k-pnl-tool k-pnl-crop', dataset: { tool: 'crop' } },
    sub('Aspect', [swap.el, lock.el], h('div', { class: 'k-pnl-chips k-pnl-chips--wrap', attrs: { role: 'group', 'aria-label': 'Aspect ratio' } }, ...chips), customRow),
    sub('Straighten', [autoBtn.el], angle.el),
    sub('Rotate & Flip', [], h('div', { class: 'k-pnl-row k-pnl-row--buttons' }, rotL.el, rotR.el, h('span', { class: 'k-pnl-sep' }), flipH.el, flipV.el)),
    sub('Overlay', [], h('div', { class: 'k-pnl-row' }, h('span', { class: 'k-pnl-row__label' }, 'Guide'), overlay.el), constrain.el),
    h('div', { class: 'k-pnl-tool__foot' }, reset.el, done.el),
  );

  d.add(
    b.watch(['crop'], (p) => {
      const off = !p;
      for (const c of chips) c.disabled = off;
      [lock, swap, rotL, rotR, flipH, flipV].forEach((x) => x.setDisabled(off));
      overlay.setDisabled(off);
      constrain.setDisabled(off);
      reset.setDisabled(off);
      autoBtn.setDisabled(off);
      if (!p) return;
      const c = p.crop;
      for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.aspect === c.aspect));
      customRow.hidden = c.aspect !== 'custom';
      customW.setValue(c.customAspect[0], true);
      customH.setValue(c.customAspect[1], true);
      lock.setPressed(c.aspect !== 'free');
      lock.setIcon(c.aspect !== 'free' ? 'lock' : 'unlock');
      overlay.setValue(c.overlay, true);
      constrain.setChecked(c.constrainToImage, true);
      flipH.el.classList.toggle('is-active', c.flipH);
      flipV.el.classList.toggle('is-active', c.flipV);
    }),
  );

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}
