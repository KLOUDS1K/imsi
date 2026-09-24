/**
 * Heal / remove tool panel: retouch mode, brush settings, the list of spots
 * and removals, sensor-dust detection and overlay visibility.
 *
 * Retouch overlays: AppContext has no signal for spot-overlay visibility, so
 * the panel publishes it as `ctx.root.dataset.retouchOverlays = 'on' | 'off'`
 * (logged in docs/CONTRACT_CHANGES.md) for the viewer to honour.
 */
import type { AppContext, RetouchTool } from '@/app/context';
import { detectDust } from '@/editor/analysis';
import { dustToSpots } from '@/editor/ai/inpaint';
import { sourceToOutput } from '@/editor/engine/geometry';
import type { HealSpot, RemovalPatch } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import {
  createBadge,
  createButton,
  createIconButton,
  createSegmentedControl,
  createSlider,
  createToggle,
  icon,
  loadLocal,
  logScale,
  saveLocal,
  type IconName,
} from '@/ui/kit';
import type { DocBinder } from './binding';
import type { ToolPanel } from './crop';
import { guarded } from './util';

const MODES: { value: RetouchTool; label: string; icon: IconName; desc: string }[] = [
  { value: 'content-aware', label: 'Content-Aware', icon: 'wand', desc: 'Click or paint over a blemish — the source is picked automatically.' },
  { value: 'heal', label: 'Heal', icon: 'heal', desc: 'Copies texture from a source area and matches tone to the surroundings.' },
  { value: 'clone', label: 'Clone', icon: 'clone', desc: 'Copies pixels exactly from a source area.' },
  { value: 'ai-remove', label: 'AI Remove', icon: 'eraser', desc: 'Brush over an object; the area is filled by patch-based inpainting on this device.' },
  { value: 'generative', label: 'Generative Remove', icon: 'sparkles', desc: 'Classical patch synthesis, runs on device — no generative AI model is used.' },
];
const KIND_ICON: Record<HealSpot['kind'] | RemovalPatch['kind'], IconName> = {
  heal: 'heal',
  clone: 'clone',
  'content-aware': 'wand',
  'ai-remove': 'eraser',
  generative: 'sparkles',
  dust: 'target',
};
const KIND_LABEL: Record<HealSpot['kind'] | RemovalPatch['kind'], string> = {
  heal: 'Heal',
  clone: 'Clone',
  'content-aware': 'Content-Aware',
  'ai-remove': 'Remove',
  generative: 'Generative',
  dust: 'Dust',
};
const OVERLAY_KEY = 'kloud-panels:retouch-overlays';

export function createHealPanel(ctx: AppContext, b: DocBinder): ToolPanel {
  const d = new Disposer();
  let selectedId: string | null = null;

  /* ---- mode ---- */
  const mode = createSegmentedControl<RetouchTool>({
    ariaLabel: 'Retouch mode',
    size: 'sm',
    block: true,
    value: ctx.retouchTool.value,
    options: MODES.map((m) => ({ value: m.value, icon: m.icon, title: m.label })),
    onChange: (v) => ctx.retouchTool.set(v),
  });
  d.add(() => mode.destroy());
  const modeName = h('span', { class: 'k-pnl-heal__mode' });
  const honest = createBadge('Classical · on-device', { tone: 'outline', title: 'Patch-based synthesis (PatchMatch-style). No generative model is downloaded or used.' });
  d.add(() => honest.destroy());
  const modeDesc = h('p', { class: 'k-pnl-note' });

  /* ---- brush (ctx.retouchBrush) ---- */
  const brushVal = ctx.retouchBrush.value;
  const longEdge = (): number => {
    const doc = b.doc;
    return doc ? Math.max(doc.meta.width || doc.source.width, doc.meta.height || doc.source.height) : 0;
  };
  const size = createSlider({
    label: 'Size',
    min: 0.002,
    max: 0.25,
    step: 0.0005,
    decimals: 4,
    value: brushVal.size,
    defaultValue: 0.02,
    scale: logScale,
    fill: 'min',
    format: (v) => {
      const le = longEdge();
      return le ? `${Math.round(v * le)} px` : `${(v * 100).toFixed(1)}%`;
    },
    id: 'retouch.size',
    onInput: (v) => ctx.retouchBrush.set({ ...ctx.retouchBrush.value, size: v }),
  });
  const feather = createSlider({
    label: 'Feather',
    min: 0,
    max: 100,
    value: brushVal.feather,
    defaultValue: 50,
    fill: 'min',
    id: 'retouch.feather',
    onInput: (v) => ctx.retouchBrush.set({ ...ctx.retouchBrush.value, feather: v }),
  });
  const opacity = createSlider({
    label: 'Opacity',
    min: 0,
    max: 100,
    value: brushVal.opacity,
    defaultValue: 100,
    fill: 'min',
    unit: '%',
    id: 'retouch.opacity',
    onInput: (v) => ctx.retouchBrush.set({ ...ctx.retouchBrush.value, opacity: v }),
  });
  d.add(() => size.destroy());
  d.add(() => feather.destroy());
  d.add(() => opacity.destroy());
  d.add(
    ctx.retouchBrush.subscribe((v) => {
      size.setValue(v.size, true);
      feather.setValue(v.feather, true);
      opacity.setValue(v.opacity, true);
    }),
  );

  function renderMode(t: RetouchTool): void {
    mode.setValue(t, true);
    const m = MODES.find((x) => x.value === t) ?? MODES[0];
    modeName.textContent = m.label;
    modeDesc.textContent = m.desc;
    honest.el.hidden = t !== 'generative' && t !== 'ai-remove';
    opacity.el.hidden = t === 'ai-remove' || t === 'generative';
  }
  d.add(ctx.retouchTool.subscribe(renderMode, true));

  /* ---- overlays ---- */
  const setOverlays = (on: boolean): void => {
    ctx.root.dataset.retouchOverlays = on ? 'on' : 'off';
    saveLocal(OVERLAY_KEY, on);
  };
  const overlays = createToggle({ label: 'Show overlays', size: 'sm', checked: loadLocal(OVERLAY_KEY, true), onChange: setOverlays });
  setOverlays(overlays.isChecked());
  d.add(() => overlays.destroy());

  /* ---- dust ---- */
  const sensitivity = createSlider({ label: 'Sensitivity', min: 0, max: 100, value: 50, defaultValue: 50, fill: 'min', id: 'retouch.dustSensitivity' });
  d.add(() => sensitivity.destroy());
  const dustBtn = createButton({
    label: 'Detect Sensor Dust',
    icon: 'target',
    size: 'sm',
    block: true,
    onClick: () => {
      const doc = b.doc;
      if (!doc) return;
      dustBtn.setBusy(true);
      // Let the busy state paint before the synchronous analysis.
      window.setTimeout(() => {
        void guarded(ctx.toast.bind(ctx), 'Dust detection', () => {
          const candidates = detectDust(doc.analysisProxy, sensitivity.getValue() / 100);
          const spots = dustToSpots(candidates, doc.analysisProxy, () => ctx.newId('spot'));
          if (!spots.length) {
            ctx.toast('No sensor dust found', 'info');
            return;
          }
          doc.store.update(
            `Remove Dust (${spots.length})`,
            (p) => {
              p.retouch.spots.push(...spots);
            },
            { coalesceKey: null },
          );
          ctx.toast(`Removed ${spots.length} dust spot${spots.length === 1 ? '' : 's'}`, 'success');
        }).finally(() => dustBtn.setBusy(false));
      }, 16);
    },
  });
  d.add(() => dustBtn.destroy());

  /* ---- list ---- */
  const list = h('ul', { class: 'k-pnl-list', attrs: { 'aria-label': 'Retouch spots' } });
  const count = h('span', { class: 'k-badge' }, '0');
  const clearAll = createButton({
    label: 'Clear All',
    size: 'sm',
    variant: 'ghost',
    onClick: async () => {
      const store = b.store;
      if (!store) return;
      const ok = await ctx.confirm({ title: 'Remove all retouching?', message: 'All heal, clone and removal spots on this photo will be removed.', confirmLabel: 'Remove All', danger: true });
      if (ok) store.update('Clear Retouching', (p) => void (p.retouch = { spots: [], removals: [] }), { coalesceKey: null });
    },
  });
  d.add(() => clearAll.destroy());

  function select(id: string, x: number, y: number): void {
    selectedId = id;
    for (const li of list.children) li.classList.toggle('is-selected', (li as HTMLElement).dataset.id === id);
    const doc = b.doc;
    if (!doc) return;
    // Centre the view on the spot (source → output coordinates).
    const o = sourceToOutput(x, y, doc.store.params, doc.source.width, doc.source.height);
    if (Number.isFinite(o.x) && Number.isFinite(o.y) && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1) {
      ctx.view.set({ ...ctx.view.value, center: { x: o.x, y: o.y } });
    }
  }

  function remove(id: string, isSpot: boolean): void {
    const store = b.store;
    if (!store) return;
    store.update(
      isSpot ? 'Delete Spot' : 'Delete Removal',
      (p) => {
        if (isSpot) p.retouch.spots = p.retouch.spots.filter((s) => s.id !== id);
        else p.retouch.removals = p.retouch.removals.filter((r) => r.id !== id);
      },
      { coalesceKey: null },
    );
    if (selectedId === id) selectedId = null;
  }

  function row(id: string, kind: HealSpot['kind'] | RemovalPatch['kind'], n: number, sub: string, x: number, y: number, isSpot: boolean): HTMLElement {
    const del = createIconButton({ icon: 'trash', label: `Delete ${KIND_LABEL[kind]} ${n}`, size: 'sm', onClick: () => remove(id, isSpot) });
    d.add(() => del.destroy());
    return h(
      'li',
      { class: ['k-pnl-list__item', id === selectedId && 'is-selected'], dataset: { id } },
      h(
        'button',
        { type: 'button', class: 'k-pnl-list__main', onclick: () => select(id, x, y), attrs: { 'aria-label': `Select ${KIND_LABEL[kind]} ${n}` } },
        h('span', { class: 'k-pnl-list__icon' }, iconEl(KIND_ICON[kind])),
        h('span', { class: 'k-pnl-list__name' }, `${KIND_LABEL[kind]} ${n}`),
        h('span', { class: 'k-pnl-list__sub k-num' }, sub),
      ),
      del.el,
    );
  }

  let lastSpots: readonly HealSpot[] | null = null;
  let lastRemovals: readonly RemovalPatch[] | null = null;
  d.add(
    b.watch(['retouch'], (p) => {
      dustBtn.setDisabled(!p);
      clearAll.setDisabled(!p || (!p.retouch.spots.length && !p.retouch.removals.length));
      if (p && p.retouch.spots === lastSpots && p.retouch.removals === lastRemovals) return;
      lastSpots = p?.retouch.spots ?? null;
      lastRemovals = p?.retouch.removals ?? null;
      list.replaceChildren();
      if (!p) {
        count.textContent = '0';
        return;
      }
      const le = longEdge();
      const counters = new Map<string, number>();
      const next = (k: string): number => {
        const n = (counters.get(k) ?? 0) + 1;
        counters.set(k, n);
        return n;
      };
      for (const s of p.retouch.spots) {
        const radius = le ? `${Math.round(s.radius * le)} px` : `${(s.radius * 100).toFixed(1)}%`;
        list.append(row(s.id, s.kind, next(s.kind), radius, s.x, s.y, true));
      }
      for (const r of p.retouch.removals) {
        list.append(row(r.id, r.kind, next(r.kind), `${Math.round(r.bbox.w * 100)}×${Math.round(r.bbox.h * 100)}%`, r.bbox.x + r.bbox.w / 2, r.bbox.y + r.bbox.h / 2, false));
      }
      const total = p.retouch.spots.length + p.retouch.removals.length;
      count.textContent = String(total);
      if (!total) list.append(h('li', { class: 'k-pnl-list__empty' }, 'No spots yet. Click on the photo to heal.'));
    }),
  );

  const el = h(
    'div',
    { class: 'k-pnl-tool k-pnl-heal', dataset: { tool: 'heal' } },
    h(
      'div',
      { class: 'k-pnl-sub' },
      h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Mode'), h('span', { class: 'k-pnl-sub__spacer' }), honest.el),
      mode.el,
      h('div', { class: 'k-pnl-heal__desc' }, modeName, modeDesc),
    ),
    h('div', { class: 'k-pnl-sub' }, h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Brush')), size.el, feather.el, opacity.el),
    h(
      'div',
      { class: 'k-pnl-sub' },
      h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Spots'), count, h('span', { class: 'k-pnl-sub__spacer' }), clearAll.el),
      list,
      overlays.el,
    ),
    h('div', { class: 'k-pnl-sub' }, h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Sensor Dust')), sensitivity.el, dustBtn.el),
  );

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}

function iconEl(name: IconName): SVGSVGElement {
  return icon(name, 14);
}
