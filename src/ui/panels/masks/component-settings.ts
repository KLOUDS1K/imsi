/**
 * Settings for the active mask component: brush (ctx.brush + erase), gradient
 * feather, colour range, luminance range, depth range and AI target status.
 * Rebuilt whenever the active component (or its kind) changes.
 */
import type { AppContext } from '@/app/context';
import type { Mask, MaskComponent } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { createButton, createSlider, createToggle, greyGradient, logScale } from '@/ui/kit';
import { type DocBinder, paramRange, paramSlider } from '../binding';
import { AI_LABEL, drawToolFor } from './create';

export interface ComponentRef {
  maskIndex: number;
  compIndex: number;
  mask: Mask;
  comp: MaskComponent;
}

/** Build the settings UI for `ref` into a fresh element; `resolve` re-finds indices at use time. */
export function buildComponentSettings(ctx: AppContext, b: DocBinder, d: Disposer, ref: ComponentRef, resolve: () => ComponentRef | null): HTMLElement {
  const base = (): string | null => {
    const r = resolve();
    return r ? `masks.${r.maskIndex}.components.${r.compIndex}` : null;
  };
  const p0 = `masks.${ref.maskIndex}.components.${ref.compIndex}`;
  const el = h('div', { class: 'k-pnl-compset', dataset: { kind: ref.comp.kind } });
  const arm = (label: string): HTMLElement => {
    const tool = drawToolFor(ref.comp);
    const btn = createButton({
      label,
      size: 'sm',
      icon: 'hand',
      variant: 'ghost',
      onClick: () => ctx.maskDrawTool.set(ctx.maskDrawTool.value === tool ? 'none' : tool),
    });
    d.add(() => btn.destroy());
    d.add(ctx.maskDrawTool.subscribe((t) => btn.el.classList.toggle('is-active', t === tool), true));
    return btn.el;
  };

  switch (ref.comp.kind) {
    case 'brush': {
      const brush = ctx.brush.value;
      const setBrush = (patch: Partial<typeof brush>): void => ctx.brush.set({ ...ctx.brush.value, ...patch });
      const size = createSlider({ label: 'Size', min: 0.002, max: 0.3, step: 0.0005, decimals: 4, scale: logScale, fill: 'min', value: brush.size, defaultValue: 0.03, id: 'brush.size', format: (v) => `${(v * 100).toFixed(1)}%`, onInput: (v) => setBrush({ size: v }) });
      const feather = createSlider({ label: 'Feather', min: 0, max: 100, fill: 'min', value: brush.feather, defaultValue: 50, id: 'brush.feather', onInput: (v) => setBrush({ feather: v }) });
      const flow = createSlider({ label: 'Flow', min: 0, max: 100, fill: 'min', value: brush.flow, defaultValue: 50, id: 'brush.flow', onInput: (v) => setBrush({ flow: v }) });
      const density = createSlider({ label: 'Density', min: 0, max: 100, fill: 'min', value: brush.density, defaultValue: 100, id: 'brush.density', onInput: (v) => setBrush({ density: v }) });
      const auto = createToggle({ label: 'Auto Mask', size: 'sm', checked: brush.autoMask, onChange: (on) => setBrush({ autoMask: on }) });
      const erase = createToggle({
        label: 'Erase',
        size: 'sm',
        checked: ctx.maskDrawTool.value === 'erase',
        onChange: (on) => ctx.maskDrawTool.set(on ? 'erase' : 'brush'),
      });
      for (const c of [size, feather, flow, density, auto, erase]) d.add(() => c.destroy());
      d.add(
        ctx.brush.subscribe((v) => {
          size.setValue(v.size, true);
          feather.setValue(v.feather, true);
          flow.setValue(v.flow, true);
          density.setValue(v.density, true);
          auto.setChecked(v.autoMask, true);
        }),
      );
      d.add(ctx.maskDrawTool.subscribe((t) => erase.setChecked(t === 'erase', true)));
      const strokes = ref.comp.brush?.strokes.length ?? 0;
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Brush'), h('span', { class: 'k-pnl-sub__spacer' }), h('span', { class: 'k-pnl-note k-num' }, `${strokes} stroke${strokes === 1 ? '' : 's'}`), arm('Paint')),
        size.el,
        feather.el,
        flow.el,
        density.el,
        h('div', { class: 'k-pnl-row k-pnl-row--toggles' }, auto.el, erase.el),
      );
      break;
    }
    case 'linear':
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Linear Gradient'), h('span', { class: 'k-pnl-sub__spacer' }), arm('Draw')),
        h('p', { class: 'k-pnl-note' }, 'Drag on the photo to draw the gradient; drag its handles to move or rotate it.'),
      );
      break;
    case 'radial':
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Radial Gradient'), h('span', { class: 'k-pnl-sub__spacer' }), arm('Draw')),
        paramSlider(b, d, `${p0}.radial.feather`, { label: 'Feather', spec: { min: 0, max: 100, step: 1, def: 50 }, fill: 'min', resolvePath: () => (base() ? `${base()}.radial.feather` : null) }).el,
      );
      break;
    case 'color-range': {
      const n = ref.comp.colorRange?.samples.length ?? 0;
      const swatches = h('div', { class: 'k-pnl-samples' });
      for (const s of ref.comp.colorRange?.samples ?? []) {
        swatches.append(h('span', { class: 'k-pnl-samples__chip', style: { background: `rgb(${Math.round(s[0] * 255)} ${Math.round(s[1] * 255)} ${Math.round(s[2] * 255)})` } }));
      }
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Color Range'), h('span', { class: 'k-pnl-sub__spacer' }), arm('Pick Colors')),
        n ? swatches : h('p', { class: 'k-pnl-note' }, 'Click the photo to sample a color (Shift-click to add up to 5).'),
        paramSlider(b, d, `${p0}.colorRange.range`, { label: 'Refine', ariaLabel: 'Color range', spec: { min: 0, max: 100, step: 1, def: 50 }, fill: 'min', resolvePath: () => (base() ? `${base()}.colorRange.range` : null) }).el,
      );
      break;
    }
    case 'luminance-range': {
      const pct = { toUi: (v: number) => v * 100, fromUi: (v: number) => v / 100 };
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Luminance Range'), h('span', { class: 'k-pnl-sub__spacer' }), arm('Sample')),
        paramRange(b, d, [`${p0}.luminanceRange.min`, `${p0}.luminanceRange.max`], {
          label: 'Range',
          min: 0,
          max: 100,
          step: 1,
          minGap: 1,
          defaultValue: [60, 100],
          gradient: greyGradient(),
          ...pct,
          resolvePaths: () => (base() ? [`${base()}.luminanceRange.min`, `${base()}.luminanceRange.max`] : null),
        }).el,
        paramSlider(b, d, `${p0}.luminanceRange.featherLow`, { label: 'Smooth Low', spec: { min: 0, max: 1, step: 0.01, def: 0.15 }, ...pct, min: 0, max: 100, step: 1, fill: 'min', resolvePath: () => (base() ? `${base()}.luminanceRange.featherLow` : null) }).el,
        paramSlider(b, d, `${p0}.luminanceRange.featherHigh`, { label: 'Smooth High', spec: { min: 0, max: 1, step: 0.01, def: 0 }, ...pct, min: 0, max: 100, step: 1, fill: 'min', resolvePath: () => (base() ? `${base()}.luminanceRange.featherHigh` : null) }).el,
      );
      break;
    }
    case 'depth-range': {
      const pct = { toUi: (v: number) => v * 100, fromUi: (v: number) => v / 100 };
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Depth Range'), h('span', { class: 'k-pnl-sub__spacer' }), arm('Sample')),
        paramRange(b, d, [`${p0}.depthRange.min`, `${p0}.depthRange.max`], {
          label: 'Depth',
          min: 0,
          max: 100,
          step: 1,
          minGap: 1,
          defaultValue: [0, 35],
          thumbLabels: ['Near', 'Far'],
          ...pct,
          resolvePaths: () => (base() ? [`${base()}.depthRange.min`, `${base()}.depthRange.max`] : null),
        }).el,
        paramSlider(b, d, `${p0}.depthRange.feather`, { label: 'Feather', spec: { min: 0, max: 1, step: 0.01, def: 0.15 }, ...pct, min: 0, max: 100, step: 1, fill: 'min', resolvePath: () => (base() ? `${base()}.depthRange.feather` : null) }).el,
        h('p', { class: 'k-pnl-note' }, 'Depth is estimated on this device (0 = near, 100 = far).'),
      );
      break;
    }
    case 'ai': {
      const target = ref.comp.ai?.target ?? 'subject';
      const status = h('span', { class: 'k-pnl-note k-pnl-aistatus' });
      const renderStatus = (): void => {
        const r = resolve();
        const key = r?.comp.ai?.bitmapKey;
        const ready = !!key && !!ctx.aiMaskStore.get(key);
        const needsPoint = target === 'object' && !r?.comp.ai?.point && !r?.comp.ai?.box;
        status.textContent = needsPoint ? 'Click or drag on the photo to select an object' : ready ? 'Ready' : 'Detecting…';
        status.classList.toggle('is-ready', ready);
      };
      renderStatus();
      d.add(ctx.aiMaskStore.onChange(renderStatus));
      d.add(b.watch(['masks'], renderStatus, false));
      const redo = createButton({
        label: 'Refresh',
        icon: 'refresh',
        size: 'sm',
        variant: 'ghost',
        onClick: () => {
          const r = resolve();
          const key = r?.comp.ai?.bitmapKey;
          if (!r) return;
          if (key) ctx.aiMaskStore.delete(key);
          // Dropping the key makes the mask provider request a fresh segmentation.
          b.store?.update('Refresh AI Mask', (p) => {
            const c = p.masks[r.maskIndex]?.components[r.compIndex];
            if (c?.ai) delete c.ai.bitmapKey;
          }, { coalesceKey: null });
        },
      });
      d.add(() => redo.destroy());
      el.append(
        h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, AI_LABEL[target]), h('span', { class: 'k-pnl-sub__spacer' }), target === 'object' ? arm('Select') : redo.el),
        status,
      );
      break;
    }
  }
  return el;
}
