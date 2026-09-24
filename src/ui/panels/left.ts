/** Develop left panel: navigator slot, presets (live hover preview), snapshots, history. */
import type { AppContext } from '../../app/context';
import { applyPreset, BUILTIN_PRESETS, createPreset, exportPresets, importPresetFile } from '../../editor/presets';
import type { EditParams, Preset } from '../../editor/types';
import { clear, Disposer, h } from '../dom';
import { createIconButton, createSection, createSlider, openMenu, type MenuItem } from '../kit';
import { DocBinder } from './binding';
import { openCreatePresetDialog } from './preset-dialog';
import { pickFiles, relativeTime, saveBlob } from './util';

export function createDevelopLeftPanel(ctx: AppContext, opts: { navigator?: HTMLElement } = {}): { el: HTMLElement; dispose(): void } {
  const d = new Disposer();
  const b = new DocBinder(ctx);
  d.add(() => b.dispose());
  const el = h('div', { class: 'k-pnl k-pnl-left' });
  const scroll = h('div', { class: 'k-pnl__scroll' });
  if (opts.navigator) el.append(h('div', { class: 'k-pnl-left__nav' }, opts.navigator));
  el.append(scroll);

  /* ------------------------------ presets ------------------------------ */
  let lastApplied: { preset: Preset; base: EditParams } | null = null;
  const presetList = h('div', { class: 'k-pnl-list' });
  const amount = createSlider({
    label: 'Amount',
    min: 0,
    max: 200,
    step: 1,
    value: 100,
    defaultValue: 100,
    unit: '%',
    fill: 'min',
    disabled: true,
    onGestureStart: () => b.store?.beginGesture('Preset amount'),
    onInput: (v) => {
      const store = b.store;
      if (!store || !lastApplied) return;
      store.replace(applyPreset(lastApplied.base, lastApplied.preset, v), `Preset: ${lastApplied.preset.name} (${v}%)`);
    },
    onGestureEnd: () => b.store?.endGesture(),
  });
  d.add(() => amount.destroy());

  const allPresets = (): Preset[] => [...BUILTIN_PRESETS, ...ctx.presets.value.filter((p) => !p.builtin)];

  const apply = (p: Preset) => {
    const store = b.store;
    if (!store) return;
    ctx.previewParams.set(null);
    const base = store.params;
    lastApplied = { preset: p, base };
    store.replace(applyPreset(base, p, 100), `Preset: ${p.name}`);
    amount.setDisabled(false);
    amount.setValue(100, true);
    renderPresets();
  };

  const presetMenu = (p: Preset): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Apply', icon: 'check', onSelect: () => apply(p) },
      { label: 'Export…', icon: 'download', onSelect: () => saveBlob(exportPresets([p]), `${p.name}.kloudpreset`) },
    ];
    if (!p.builtin) {
      items.push(
        {
          label: 'Update with current settings',
          icon: 'refresh',
          onSelect: () => {
            const params = b.params;
            if (!params) return;
            const updated = { ...createPreset(p.name, params, p.groups, { group: p.group, conditions: p.conditions }), id: p.id, created: p.created };
            void ctx.savePreset(updated).then(() => ctx.toast(`Updated “${p.name}”.`, 'success'));
          },
        },
        {
          label: 'Rename…',
          icon: 'text',
          onSelect: async () => {
            const name = await ctx.prompt({ title: 'Rename preset', value: p.name, confirmLabel: 'Rename' });
            if (name) await ctx.savePreset({ ...p, name: name.trim(), updated: Date.now() });
          },
        },
        { kind: 'separator' },
        {
          label: 'Delete',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            if (await ctx.confirm({ title: `Delete “${p.name}”?`, confirmLabel: 'Delete', danger: true })) await ctx.deletePreset(p.id);
          },
        },
      );
    }
    return items;
  };

  function renderPresets(): void {
    clear(presetList);
    const groups = new Map<string, Preset[]>();
    for (const p of allPresets()) {
      const list = groups.get(p.group) ?? [];
      list.push(p);
      groups.set(p.group, list);
    }
    for (const [group, list] of groups) {
      presetList.append(h('div', { class: 'k-pnl-sub__title k-pnl-preset__group' }, group));
      for (const p of list) {
        const row = h(
          'div',
          {
            class: ['k-pnl-preset', lastApplied?.preset.id === p.id && 'is-active'],
            attrs: { role: 'button', tabindex: 0, title: `Groups: ${p.groups.join(', ')}` },
            onclick: () => apply(p),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') apply(p);
            },
            onpointerenter: () => {
              const params = b.params;
              if (params) ctx.previewParams.set(applyPreset(params, p, 100));
            },
            onpointerleave: () => ctx.previewParams.set(null),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              openMenu({ x: e.clientX, y: e.clientY } as never, presetMenu(p));
            },
          },
          h('span', { class: 'k-pnl-list__name' }, p.name),
        );
        presetList.append(row);
      }
    }
  }

  const addPreset = createIconButton({
    icon: 'plus',
    label: 'Create preset from current settings',
    size: 'sm',
    onClick: () => void openCreatePresetDialog(ctx),
  });
  const importBtn = createIconButton({
    icon: 'upload',
    label: 'Import presets (.kloudpreset, .json, Lightroom .xmp)',
    size: 'sm',
    onClick: async () => {
      const files = await pickFiles('.kloudpreset,.json,.xmp,application/json', true);
      let n = 0;
      for (const f of files) {
        try {
          for (const p of await importPresetFile(f)) {
            await ctx.savePreset(p);
            n++;
          }
        } catch (e) {
          ctx.toast(`Couldn't import ${f.name}: ${(e as Error).message}`, 'error');
        }
      }
      if (n) ctx.toast(`Imported ${n} preset${n === 1 ? '' : 's'}.`, 'success');
    },
  });
  const exportBtn = createIconButton({
    icon: 'download',
    label: 'Export user presets',
    size: 'sm',
    onClick: () => {
      const user = ctx.presets.value.filter((p) => !p.builtin);
      if (!user.length) return ctx.toast('No user presets to export yet.', 'info');
      saveBlob(exportPresets(user), 'kloud-presets.kloudpreset');
    },
  });
  d.add(() => [addPreset, importBtn, exportBtn].forEach((c) => c.destroy()));
  const presets = createSection({ id: 'develop.presets', title: 'Presets', open: true, persist: true, actions: [addPreset.el, importBtn.el, exportBtn.el] });
  presets.body.append(presetList, amount.el);
  d.add(ctx.presets.subscribe(renderPresets));
  d.add(b.onDoc(() => {
    lastApplied = null;
    amount.setDisabled(true);
    renderPresets();
  }));

  /* ------------------------------ snapshots ----------------------------- */
  const snapList = h('div', { class: 'k-pnl-list' });
  const renderSnapshots = () => {
    clear(snapList);
    const store = b.store;
    const snaps = store?.snapshots ?? [];
    if (!snaps.length) snapList.append(h('div', { class: 'k-pnl-list__empty' }, 'Save named versions of your edit to compare or return to.'));
    for (const s of snaps) {
      const more = createIconButton({
        icon: 'more-horizontal',
        label: 'Snapshot options',
        size: 'sm',
        onClick: (e) => {
          e.stopPropagation();
          openMenu(more.el, [
            { label: 'Apply', icon: 'check', onSelect: () => store?.applySnapshot(s.id) },
            {
              label: 'Compare with current',
              icon: 'compare',
              onSelect: () => {
                ctx.compareParams.set(s.params);
                ctx.view.set({ ...ctx.view.value, compare: 'split-vertical' });
              },
            },
            {
              label: 'Rename…',
              icon: 'text',
              onSelect: async () => {
                const name = await ctx.prompt({ title: 'Rename snapshot', value: s.name });
                if (name) store?.renameSnapshot(s.id, name.trim());
              },
            },
            { kind: 'separator' },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: () => store?.deleteSnapshot(s.id) },
          ]);
        },
      });
      snapList.append(
        h(
          'div',
          { class: 'k-pnl-list__item', onclick: () => store?.applySnapshot(s.id), attrs: { role: 'button', tabindex: 0 } },
          h('span', { class: 'k-pnl-list__main' }, h('span', { class: 'k-pnl-list__name' }, s.name), h('span', { class: 'k-pnl-list__sub' }, relativeTime(s.created))),
          more.el,
        ),
      );
    }
  };
  const addSnap = createIconButton({
    icon: 'plus',
    label: 'New snapshot',
    shortcut: 'Mod+Shift+N',
    size: 'sm',
    onClick: async () => {
      const store = b.store;
      if (!store) return;
      const name = await ctx.prompt({ title: 'New snapshot', value: `Snapshot ${store.snapshots.length + 1}`, confirmLabel: 'Save' });
      if (name) store.createSnapshot(name.trim());
    },
  });
  d.add(() => addSnap.destroy());
  const snapshots = createSection({ id: 'develop.snapshots', title: 'Snapshots', open: false, persist: true, actions: [addSnap.el] });
  snapshots.body.append(snapList);

  /* ------------------------------ history ------------------------------ */
  const histList = h('div', { class: 'k-pnl-list' });
  const renderHistory = () => {
    clear(histList);
    const store = b.store;
    if (!store) return;
    const entries = store.history;
    const start = Math.max(0, entries.length - 120);
    for (let i = entries.length - 1; i >= start; i--) {
      const e = entries[i];
      histList.append(
        h(
          'div',
          {
            class: ['k-pnl-list__item k-pnl-hist-entry', i === store.historyIndex && 'is-current', i > store.historyIndex && 'is-future'],
            onclick: () => store.goToHistory(i),
            attrs: { role: 'button', tabindex: 0 },
          },
          h('span', { class: 'k-pnl-list__main' }, h('span', { class: 'k-pnl-list__name' }, e.label), h('span', { class: 'k-pnl-list__sub' }, relativeTime(e.time))),
        ),
      );
    }
  };
  const clearHist = createIconButton({
    icon: 'trash',
    label: 'Clear history',
    size: 'sm',
    onClick: async () => {
      if (await ctx.confirm({ title: 'Clear edit history?', message: 'Your current settings stay; only the list of steps is removed.', confirmLabel: 'Clear' })) b.store?.clearHistory();
    },
  });
  d.add(() => clearHist.destroy());
  const history = createSection({ id: 'develop.history', title: 'History', open: true, persist: true, actions: [clearHist.el] });
  history.body.append(histList);

  let raf = 0;
  const refreshLists = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      renderHistory();
      renderSnapshots();
    });
  };
  d.add(b.watch(null, refreshLists));
  d.add(b.onDoc(refreshLists));
  d.add(() => cancelAnimationFrame(raf));

  scroll.append(presets.el, snapshots.el, history.el);
  d.add(() => [presets, snapshots, history].forEach((s) => s.destroy()));
  return { el, dispose: () => d.dispose() };
}
