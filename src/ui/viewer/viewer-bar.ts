/**
 * The viewer's bottom toolbar and the compare furniture drawn over the image:
 * compare modes (bound to ctx.view.compare), hold-to-view-original, reference
 * photo picker, clipping toggle, zoom menu / indicator, the crop tool's bar
 * (straighten, overlay, angle, cancel / done), "Before / After" chips and the
 * draggable split divider (ctx.view.splitPosition, viewport-normalized).
 */
import type { AppContext } from '@/app/context';
import type { CompareMode } from '@/editor/contracts';
import { Disposer, h, on } from '@/ui/dom';
import type { Signal } from '@/ui/signal';
import {
  attachMenu,
  createButton,
  createIconButton,
  createSegmentedControl,
  icon,
  type MenuItem,
} from '@/ui/kit';
import { OVERLAY_CYCLE, OVERLAY_LABELS } from './crop-guides';
import { ZOOM_PRESETS, zoomLabel } from './view-math';
import { setCompare, setSplitPosition, setZoom, stepZoom, toggleClipping, viewportInfo } from './zoom';

export interface ViewerBar {
  readonly el: HTMLElement;
  /** Chips + divider layer (goes inside the stage, above the overlay). */
  readonly furniture: HTMLElement;
  /** Refresh zoom label etc. (after renders / resizes). */
  refresh(): void;
  /** Start / stop "view original" (used by touch long-press on the image). */
  holdOriginal(on: boolean): void;
  dispose(): void;
}

const COMPARE_OPTIONS: { value: CompareMode; icon: Parameters<typeof icon>[0]; title: string }[] = [
  { value: 'off', icon: 'image', title: 'Loupe (no compare)' },
  { value: 'before', icon: 'history', title: 'Before  \\' },
  { value: 'side-by-side', icon: 'columns', title: 'Before / After side by side  Y' },
  { value: 'split-vertical', icon: 'split-v', title: 'Split vertical' },
  { value: 'split-horizontal', icon: 'split-h', title: 'Split horizontal' },
  { value: 'reference', icon: 'images', title: 'Reference photo' },
];

export interface ViewerBarOptions {
  straighten: Signal<boolean>;
  onCropReset: () => void;
  /** Escape semantics of the crop tool (revert to the params at tool entry). */
  onCropCancel: () => void;
}

export function createViewerBar(ctx: AppContext, opts: ViewerBarOptions): ViewerBar {
  const d = new Disposer();

  /* ------------------------------ compare ------------------------------ */
  const compare = createSegmentedControl<CompareMode>({
    options: COMPARE_OPTIONS.map((o) => ({ value: o.value, icon: o.icon, title: o.title })),
    value: ctx.view.value.compare,
    ariaLabel: 'Compare mode',
    size: 'sm',
    onChange: (v) => {
      setCompare(ctx, v);
      if (v === 'reference' && !ctx.referenceId.value) openReferenceMenu();
    },
  });
  d.add(() => compare.destroy());

  // Hold to view the original (press and hold; Space/Enter held on the button too).
  let held: CompareMode | null = null;
  const holdOriginal = (onOff: boolean): void => {
    if (onOff && held === null) {
      held = ctx.view.value.compare;
      setCompare(ctx, 'before');
      eye.el.classList.add('is-active');
    } else if (!onOff && held !== null) {
      setCompare(ctx, held);
      held = null;
      eye.el.classList.remove('is-active');
    }
  };
  const eye = createIconButton({ icon: 'eye', label: 'Hold to view original', size: 'sm', tooltip: 'top' });
  d.add(() => eye.destroy());
  d.add(
    on(eye.el, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      eye.el.setPointerCapture(e.pointerId);
      holdOriginal(true);
    }),
  );
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) d.add(on(eye.el, t, () => holdOriginal(false)));
  d.add(
    on(eye.el, 'keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        holdOriginal(true);
      }
    }),
  );
  d.add(on(eye.el, 'keyup', (e) => (e.key === ' ' || e.key === 'Enter') && holdOriginal(false)));
  d.add(on(eye.el, 'contextmenu', (e) => e.preventDefault()));

  // Reference picker.
  const refBtn = h('button', { type: 'button', class: 'k-vbar__ref', attrs: { 'aria-haspopup': 'menu' } }, icon('images', 14), h('span', { class: 'k-vbar__ref-name k-truncate' }, 'Choose reference…'), icon('chevron-down', 12));
  const refName = refBtn.querySelector('.k-vbar__ref-name') as HTMLElement;
  const referenceItems = (): MenuItem[] => {
    const cur = ctx.doc.value?.photoId;
    const ids = ctx.visibleIds.value.filter((id) => id !== cur).slice(0, 60);
    if (!ids.length) return [{ label: 'No other photos in view', disabled: true }];
    const items: MenuItem[] = [{ kind: 'header', label: 'Reference photo' }];
    for (const id of ids) {
      const rec = ctx.library.get(id);
      items.push({ label: rec?.name ?? id, checked: ctx.referenceId.value === id, onSelect: () => ctx.referenceId.set(id) });
    }
    if (ctx.referenceId.value) items.push({ kind: 'separator' }, { label: 'Clear reference', icon: 'x', onSelect: () => ctx.referenceId.set(null) });
    return items;
  };
  d.add(attachMenu(refBtn, referenceItems, { placement: 'top-start' }));
  function openReferenceMenu(): void {
    queueMicrotask(() => refBtn.click());
  }

  /* ------------------------------ right group ------------------------------ */
  const clip = createIconButton({
    icon: 'alert',
    label: 'Show clipping',
    shortcut: 'J',
    size: 'sm',
    pressed: ctx.view.value.clipping.highlights || ctx.view.value.clipping.shadows,
    autoToggle: false,
    tooltip: 'top',
    onClick: () => toggleClipping(ctx),
  });
  d.add(() => clip.destroy());
  const zoomOut = createIconButton({ icon: 'zoom-out', label: 'Zoom out', shortcut: '-', size: 'sm', tooltip: 'top', class: 'k-vbar__zstep', onClick: () => stepZoom(ctx, -1) });
  const zoomIn = createIconButton({ icon: 'zoom-in', label: 'Zoom in', shortcut: '=', size: 'sm', tooltip: 'top', class: 'k-vbar__zstep', onClick: () => stepZoom(ctx, 1) });
  d.add(() => zoomOut.destroy());
  d.add(() => zoomIn.destroy());
  const zoomBtn = h('button', { type: 'button', class: 'k-vbar__zoom k-num', attrs: { 'aria-haspopup': 'menu', 'aria-label': 'Zoom level' } }, 'Fit');
  d.add(
    attachMenu(
      zoomBtn,
      () =>
        ZOOM_PRESETS.map<MenuItem>((p) => ({
          label: p === 'fit' ? 'Fit' : p === 'fill' ? 'Fill' : `${p}%`,
          shortcut: p === 'fit' ? 'Z' : undefined,
          checked: p === 'fit' ? ctx.view.value.zoom === 'fit' : typeof p === 'number' && ctx.view.value.zoom === p / 100,
          onSelect: () => setZoom(ctx, p),
        })),
      { placement: 'top-end' },
    ),
  );

  /* ------------------------------ crop bar ------------------------------ */
  const straightenBtn = createIconButton({
    icon: 'straighten',
    label: 'Straighten tool — draw along the horizon',
    size: 'sm',
    pressed: opts.straighten.value,
    tooltip: 'top',
    onToggle: (p) => opts.straighten.set(p),
  });
  d.add(() => straightenBtn.destroy());
  d.add(opts.straighten.subscribe((v) => straightenBtn.setPressed(v)));
  const overlayBtn = createIconButton({ icon: 'grid-3', label: 'Crop overlay', shortcut: 'O', size: 'sm', tooltip: 'top' });
  d.add(() => overlayBtn.destroy());
  d.add(
    attachMenu(
      overlayBtn.el,
      () => {
        const cur = ctx.doc.value?.store.params.crop.overlay ?? 'thirds';
        return OVERLAY_CYCLE.map<MenuItem>((o) => ({
          label: OVERLAY_LABELS[o],
          checked: o === cur,
          onSelect: () => ctx.doc.value?.store.set('crop.overlay', o, { label: 'Crop Overlay' }),
        }));
      },
      { placement: 'top-start' },
    ),
  );
  const angleEl = h('span', { class: 'k-vbar__angle k-num', attrs: { 'aria-label': 'Straighten angle' } }, '0.00°');
  const resetBtn = createIconButton({ icon: 'reset', label: 'Reset crop', size: 'sm', tooltip: 'top', onClick: opts.onCropReset });
  d.add(() => resetBtn.destroy());
  const cancelBtn = createButton({ label: 'Cancel', size: 'sm', variant: 'ghost', onClick: opts.onCropCancel });
  const doneBtn = createButton({ label: 'Done', size: 'sm', variant: 'primary', onClick: () => ctx.tool.set('edit') });
  d.add(() => cancelBtn.destroy());
  d.add(() => doneBtn.destroy());

  const compareGroup = h('div', { class: 'k-vbar__group k-vbar__group--compare' }, compare.el, eye.el, refBtn);
  const cropGroup = h('div', { class: 'k-vbar__group k-vbar__group--crop' }, straightenBtn.el, overlayBtn.el, angleEl, resetBtn.el);
  const cropActions = h('div', { class: 'k-vbar__group k-vbar__group--crop' }, cancelBtn.el, doneBtn.el);
  const zoomGroup = h('div', { class: 'k-vbar__group' }, clip.el, h('span', { class: 'k-vbar__sep', attrs: { 'aria-hidden': 'true' } }), zoomOut.el, zoomBtn, zoomIn.el);
  const el = h('div', { class: 'k-vbar', attrs: { role: 'toolbar', 'aria-label': 'Viewer' } }, compareGroup, cropGroup, h('div', { class: 'k-vbar__spacer' }), zoomGroup, cropActions);

  /* ------------------------------ furniture ------------------------------ */
  const chipA = h('span', { class: 'k-vchip' });
  const chipB = h('span', { class: 'k-vchip' });
  const knobEl = h('span', { class: 'k-split__knob' }, icon('arrow-left', 11), icon('arrow-right', 11));
  const divider = h(
    'div',
    {
      class: 'k-split',
      tabIndex: 0,
      attrs: { role: 'separator', 'aria-label': 'Before / after divider', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    },
    h('span', { class: 'k-split__line' }),
    knobEl,
  );
  const furniture = h('div', { class: 'k-vfurniture' }, chipA, chipB, divider);

  let dragging = false;
  d.add(
    on(divider, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      dragging = true;
      divider.classList.add('is-dragging');
    }),
  );
  d.add(
    on(divider, 'pointermove', (e) => {
      if (!dragging) return;
      const r = furniture.getBoundingClientRect();
      const vertical = ctx.view.value.compare === 'split-vertical';
      const pos = vertical ? (e.clientX - r.left) / Math.max(1, r.width) : (e.clientY - r.top) / Math.max(1, r.height);
      setSplitPosition(ctx, pos);
    }),
  );
  const endDrag = (): void => {
    dragging = false;
    divider.classList.remove('is-dragging');
  };
  d.add(on(divider, 'pointerup', endDrag));
  d.add(on(divider, 'pointercancel', endDrag));
  d.add(
    on(divider, 'keydown', (e) => {
      const vertical = ctx.view.value.compare === 'split-vertical';
      const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
      const inc = vertical ? 'ArrowRight' : 'ArrowDown';
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === dec || e.key === inc) {
        e.preventDefault();
        e.stopPropagation();
        setSplitPosition(ctx, ctx.view.value.splitPosition + (e.key === inc ? step : -step));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setSplitPosition(ctx, e.key === 'Home' ? 0.02 : 0.98);
      }
    }),
  );

  function compareLabel(): string {
    const doc = ctx.doc.value;
    const cp = ctx.compareParams.value;
    if (doc && cp) {
      const snap = doc.store.snapshots.find((s) => s.params === cp);
      if (snap) return snap.name;
    }
    return 'Before';
  }

  function render(): void {
    const v = ctx.view.value;
    const tool = ctx.tool.value;
    const crop = tool === 'crop';
    el.classList.toggle('is-crop', crop);
    compare.setValue(held !== null ? held : v.compare, true);
    clip.setPressed(v.clipping.highlights || v.clipping.shadows);
    refBtn.hidden = v.compare !== 'reference';
    const refRec = ctx.referenceId.value ? ctx.library.get(ctx.referenceId.value) : undefined;
    refName.textContent = refRec?.name ?? 'Choose reference…';
    const angle = ctx.doc.value?.store.params.crop.angle ?? 0;
    angleEl.textContent = `${angle > 0 ? '+' : angle < 0 ? '−' : ''}${Math.abs(angle).toFixed(2)}°`;
    zoomBtn.textContent = zoomLabel(v.zoom, viewportInfo(ctx));

    // Chips and divider.
    const mode = crop ? 'off' : v.compare;
    furniture.dataset.mode = mode;
    const split = mode === 'split-vertical' || mode === 'split-horizontal';
    divider.hidden = !split;
    divider.classList.toggle('is-horizontal', mode === 'split-horizontal');
    divider.setAttribute('aria-orientation', mode === 'split-horizontal' ? 'horizontal' : 'vertical');
    divider.setAttribute('aria-valuenow', String(Math.round(v.splitPosition * 100)));
    const pct = `${(v.splitPosition * 100).toFixed(3)}%`;
    divider.style.left = mode === 'split-vertical' ? pct : '';
    divider.style.top = mode === 'split-horizontal' ? pct : '';
    const before = compareLabel();
    const set = (c: HTMLElement, text: string | null, pos: string): void => {
      c.hidden = text === null;
      if (text !== null) c.textContent = text;
      c.dataset.pos = pos;
    };
    switch (mode) {
      case 'before':
        set(chipA, before, 'tl');
        set(chipB, null, '');
        break;
      case 'side-by-side':
        set(chipA, before, 'tl');
        set(chipB, 'After', 'tc');
        break;
      case 'split-vertical':
        set(chipA, before, 'tl');
        set(chipB, 'After', 'tr');
        break;
      case 'split-horizontal':
        set(chipA, before, 'tl');
        set(chipB, 'After', 'bl');
        break;
      case 'reference':
        set(chipA, 'Reference', 'tl');
        set(chipB, 'Current', 'tc');
        break;
      default:
        set(chipA, null, '');
        set(chipB, null, '');
    }
  }

  for (const s of [ctx.view, ctx.tool, ctx.referenceId, ctx.compareParams] as Signal<unknown>[]) d.add(s.subscribe(render));
  d.add(ctx.doc.subscribe(render));
  let unsubStore: (() => void) | null = null;
  d.add(
    ctx.doc.subscribe((doc) => {
      unsubStore?.();
      unsubStore = doc ? doc.store.subscribe((_p, info) => info.paths.some((p) => p === '*' || p.startsWith('crop')) && render()) : null;
    }, true),
  );
  d.add(() => unsubStore?.());
  render();

  return {
    el,
    furniture,
    refresh: render,
    holdOriginal,
    dispose() {
      holdOriginal(false);
      d.dispose();
      el.remove();
      furniture.remove();
    },
  };
}
