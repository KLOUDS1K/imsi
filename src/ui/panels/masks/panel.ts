/**
 * Masks tool panel: mask list, "Create new mask" menu, components of the
 * active mask (mode / invert / settings), mask amount and the local
 * adjustment sliders.
 */
import type { AppContext } from '../../../app/context';
import { createMask, LOCAL_SPECS } from '../../../editor/defaults';
import type { LocalAdjustments, Mask, MaskMode } from '../../../editor/types';
import { clear, Disposer, h } from '../../dom';
import { createButton, createIconButton, createToggle, icon, openMenu, type MenuItem } from '../../kit';
import { paramSlider, type DocBinder } from '../binding';
import type { ToolPanel } from '../crop';
import { buildComponentSettings } from './component-settings';
import { componentIcon, componentLabel, drawToolFor, MODE_LABEL, maskMenuItems, newComponent, type MaskChoice } from './create';

const ADJ_LABELS: Record<keyof LocalAdjustments, string> = {
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  whites: 'Whites',
  blacks: 'Blacks',
  temperature: 'Temperature',
  tint: 'Tint',
  saturation: 'Saturation',
  texture: 'Texture',
  clarity: 'Clarity',
  dehaze: 'Dehaze',
  sharpness: 'Sharpness',
  noise: 'Noise',
};

/** Structural signature: rebuild the panel only when this changes (not on every slider tick). */
function signature(masks: readonly Mask[], active: string | null): string {
  return JSON.stringify([active, masks.map((m) => [m.id, m.name, m.visible, m.invert, m.components.map((c) => [c.id, c.kind, c.mode, c.invert])])]);
}

export function createMasksPanel(ctx: AppContext, b: DocBinder): ToolPanel {
  const d = new Disposer();
  const el = h('div', { class: 'k-pnl-tool k-pnl-masks' });
  let inner = new Disposer();
  let lastSig = '';

  const indexOf = (id: string | null): number => (id ? (b.params?.masks.findIndex((m) => m.id === id) ?? -1) : -1);

  const addMask = (choice: MaskChoice) => {
    const store = b.store;
    if (!store) return;
    const mask = createMask(`Mask ${store.params.masks.length + 1}`, ctx.newId('mask'));
    mask.components = [newComponent(ctx.newId('mc'), choice, 'add')];
    store.update(`New Mask: ${componentLabel(mask.components[0])}`, (p) => {
      p.masks.push(mask);
    });
    ctx.activeMaskId.set(mask.id);
    ctx.maskDrawTool.set(drawToolFor(choice));
  };

  const addComponent = (maskId: string, choice: MaskChoice, mode: MaskMode) => {
    const store = b.store;
    const i = indexOf(maskId);
    if (!store || i < 0) return;
    const comp = newComponent(ctx.newId('mc'), choice, mode);
    store.update(`${MODE_LABEL[mode]}: ${componentLabel(comp)}`, (p) => {
      p.masks[i].components.push(comp);
    });
    ctx.maskDrawTool.set(drawToolFor(choice));
  };

  const maskMenu = (m: Mask, i: number): MenuItem[] => [
    {
      label: 'Rename…',
      icon: 'text',
      onSelect: async () => {
        const name = await ctx.prompt({ title: 'Rename mask', value: m.name, confirmLabel: 'Rename' });
        if (name) b.store?.update('Rename Mask', (p) => void (p.masks[i].name = name.trim() || m.name));
      },
    },
    { label: m.invert ? 'Uninvert mask' : 'Invert mask', icon: 'contrast', onSelect: () => b.store?.update('Invert Mask', (p) => void (p.masks[i].invert = !p.masks[i].invert)) },
    {
      label: 'Duplicate',
      icon: 'copy',
      onSelect: () =>
        b.store?.update('Duplicate Mask', (p) => {
          const copy: Mask = { ...structuredClone(p.masks[i]), id: ctx.newId('mask'), name: `${m.name} copy` };
          copy.components = copy.components.map((c) => ({ ...c, id: ctx.newId('mc') }));
          p.masks.splice(i + 1, 0, copy);
        }),
    },
    { kind: 'separator' },
    {
      label: 'Delete mask',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        b.store?.update('Delete Mask', (p) => void p.masks.splice(i, 1));
        if (ctx.activeMaskId.value === m.id) ctx.activeMaskId.set(null);
      },
    },
  ] as MenuItem[];

  function render(): void {
    inner.dispose();
    inner = new Disposer();
    clear(el);
    const params = b.params;
    if (!params) {
      el.append(h('p', { class: 'k-pnl-note' }, 'Open a photo to add masks.'));
      return;
    }
    const createBtn = createButton({
      label: 'Create new mask',
      icon: 'plus',
      variant: 'primary',
      size: 'sm',
      onClick: () => openMenu(createBtn.el, maskMenuItems(addMask, 'Heuristic'), { ariaLabel: 'Create new mask', minWidth: 220 }),
    });
    const overlay = createToggle({
      checked: ctx.showMaskOverlay.value,
      label: 'Overlay',
      size: 'sm',
      onChange: (on) => ctx.showMaskOverlay.set(on),
    });
    inner.add(ctx.showMaskOverlay.subscribe((v) => overlay.setChecked(v, true)));
    inner.add(() => {
      createBtn.destroy();
      overlay.destroy();
    });
    el.append(h('div', { class: 'k-pnl-row k-pnl-row--split' }, createBtn.el, overlay.el));

    const list = h('div', { class: 'k-pnl-list', attrs: { role: 'listbox', 'aria-label': 'Masks' } });
    if (params.masks.length === 0) {
      list.append(h('div', { class: 'k-pnl-list__empty' }, 'No masks yet. Masks limit adjustments to part of the photo — subject, sky, a brushed area or a gradient.'));
    }
    params.masks.forEach((m, i) => {
      const eye = createIconButton({
        icon: m.visible ? 'eye' : 'eye-off',
        label: m.visible ? 'Hide mask' : 'Show mask',
        size: 'sm',
        onClick: (e) => {
          e.stopPropagation();
          b.store?.update(m.visible ? 'Hide Mask' : 'Show Mask', (p) => void (p.masks[i].visible = !p.masks[i].visible));
        },
      });
      const more = createIconButton({
        icon: 'more-horizontal',
        label: 'Mask options',
        size: 'sm',
        onClick: (e) => {
          e.stopPropagation();
          openMenu(more.el, maskMenu(m, i), { ariaLabel: 'Mask options' });
        },
      });
      inner.add(() => {
        eye.destroy();
        more.destroy();
      });
      const first = m.components[0];
      const row = h(
        'div',
        {
          class: ['k-pnl-list__item', ctx.activeMaskId.value === m.id && 'is-active'],
          attrs: { role: 'option', 'aria-selected': ctx.activeMaskId.value === m.id, tabindex: 0 },
          onclick: () => ctx.activeMaskId.set(m.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') ctx.activeMaskId.set(m.id);
          },
        },
        h('span', { class: 'k-pnl-list__icon' }, icon(first ? componentIcon(first) : 'layers', 14)),
        h(
          'span',
          { class: 'k-pnl-list__main' },
          h('span', { class: 'k-pnl-list__name' }, m.name),
          h('span', { class: 'k-pnl-list__sub' }, `${m.components.length} component${m.components.length === 1 ? '' : 's'}${m.invert ? ' · inverted' : ''}`),
        ),
        eye.el,
        more.el,
      );
      list.append(row);
    });
    el.append(list);

    const ai = indexOf(ctx.activeMaskId.value);
    if (ai < 0) return;
    const mask = params.masks[ai];
    const maskId = mask.id;
    const resolve = (suffix: string) => () => {
      const i = indexOf(maskId);
      return i >= 0 ? `masks.${i}.${suffix}` : null;
    };

    el.append(h('div', { class: 'k-pnl-sep' }));
    el.append(h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, `${mask.name} · components`)));
    mask.components.forEach((comp, ci) => {
      const modeBtn = createButton({
        label: ci === 0 ? 'Base' : MODE_LABEL[comp.mode],
        size: 'sm',
        variant: 'ghost',
        disabled: ci === 0,
        onClick: () =>
          openMenu(
            modeBtn.el,
            (['add', 'subtract', 'intersect'] as MaskMode[]).map((mode) => ({
              label: MODE_LABEL[mode],
              checked: comp.mode === mode,
              onSelect: () => b.store?.update(`Mask mode: ${MODE_LABEL[mode]}`, (p) => void (p.masks[ai].components[ci].mode = mode)),
            })) as MenuItem[],
          ),
      });
      const inv = createIconButton({
        icon: 'contrast',
        label: comp.invert ? 'Uninvert component' : 'Invert component',
        size: 'sm',
        pressed: comp.invert,
        onClick: () => b.store?.update('Invert Component', (p) => void (p.masks[ai].components[ci].invert = !p.masks[ai].components[ci].invert)),
      });
      const del = createIconButton({
        icon: 'trash',
        label: 'Delete component',
        size: 'sm',
        onClick: () =>
          b.store?.update('Delete Component', (p) => {
            p.masks[ai].components.splice(ci, 1);
            if (p.masks[ai].components.length === 0) p.masks.splice(ai, 1);
          }),
      });
      inner.add(() => {
        modeBtn.destroy();
        inv.destroy();
        del.destroy();
      });
      const settings = buildComponentSettings(ctx, b, inner, { maskIndex: ai, compIndex: ci, mask, comp }, () => {
        const i = indexOf(maskId);
        const m = i >= 0 ? b.params?.masks[i] : undefined;
        const c = m?.components.findIndex((x) => x.id === comp.id) ?? -1;
        return m && c >= 0 ? { maskIndex: i, compIndex: c, mask: m, comp: m.components[c] } : null;
      });
      el.append(
        h(
          'div',
          { class: 'k-pnl-compset' },
          h('div', { class: 'k-pnl-row' }, icon(componentIcon(comp), 14), h('strong', { class: 'k-pnl-list__name' }, componentLabel(comp)), h('span', { class: 'k-pnl-sub__spacer' }), modeBtn.el, inv.el, del.el),
          settings,
        ),
      );
    });
    const addRow = h('div', { class: 'k-pnl-row k-pnl-row--buttons' });
    (['add', 'subtract', 'intersect'] as MaskMode[]).forEach((mode) => {
      const btn = createButton({
        label: MODE_LABEL[mode],
        icon: mode === 'add' ? 'plus' : mode === 'subtract' ? 'minus' : 'layers',
        size: 'sm',
        onClick: () => openMenu(btn.el, maskMenuItems((c) => addComponent(maskId, c, mode), 'Heuristic'), { minWidth: 220 }),
      });
      inner.add(() => btn.destroy());
      addRow.append(btn.el);
    });
    el.append(addRow);

    el.append(h('div', { class: 'k-pnl-sep' }));
    const adj = h('div', { class: 'k-pnl-mask__adj' });
    adj.append(paramSlider(b, inner, `masks.${ai}.amount`, { label: 'Amount', spec: { min: 0, max: 100, step: 1, def: 100 }, fill: 'min', resolvePath: resolve('amount') }).el);
    for (const key of Object.keys(LOCAL_SPECS) as (keyof LocalAdjustments)[]) {
      adj.append(
        paramSlider(b, inner, `masks.${ai}.adjustments.${key}`, {
          label: ADJ_LABELS[key],
          spec: LOCAL_SPECS[key],
          resolvePath: resolve(`adjustments.${key}`),
        }).el,
      );
    }
    el.append(adj);
  }

  const maybeRender = () => {
    const sig = signature(b.params?.masks ?? [], ctx.activeMaskId.value);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  };
  d.add(b.watch(['masks'], maybeRender));
  d.add(b.onDoc(() => {
    lastSig = '';
    maybeRender();
  }));
  d.add(ctx.activeMaskId.subscribe(maybeRender));

  return {
    el,
    dispose() {
      inner.dispose();
      d.dispose();
    },
  };
}
