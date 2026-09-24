/**
 * Develop panels: the right panel (histogram, tool strip, tool panels) and
 * the left panel (navigator, presets, snapshots, history).
 */
import './panels.css';
import type { AppContext, DevelopTool } from '../../app/context';
import { clear, Disposer, h } from '../dom';
import { createIconButton, type IconName } from '../kit';
import { createAiPanel } from './ai';
import { DocBinder } from './binding';
import { createCropPanel, type ToolPanel } from './crop';
import { applyAutoTone, createBasicSection } from './edit/basic';
import { createColorGradingSection } from './edit/color-grading';
import { createColorMixerSection } from './edit/color-mixer';
import { createCalibrationSection, createDetailSection, createEffectsSection } from './edit/detail-effects';
import { createGeometrySection, createOpticsSection } from './edit/optics-geometry';
import { createToneCurveSection } from './edit/tone-curve';
import { createHealPanel } from './heal';
import { createHistogramBlock } from './histogram';
import { createMasksPanel } from './masks/panel';
import { openDevelopMenu } from './develop-menu';

export { createDevelopLeftPanel } from './left';

const TOOLS: { id: DevelopTool; icon: IconName; label: string; key: string }[] = [
  { id: 'edit', icon: 'sliders', label: 'Edit', key: 'E' },
  { id: 'crop', icon: 'crop', label: 'Crop & rotate', key: 'R' },
  { id: 'heal', icon: 'bandage', label: 'Remove & heal', key: 'Q' },
  { id: 'masks', icon: 'layers', label: 'Masks', key: 'Shift+W' },
  { id: 'ai', icon: 'sparkles', label: 'AI & KLOUD Style', key: 'A' },
];

function createEditPanel(ctx: AppContext, b: DocBinder): ToolPanel {
  const d = new Disposer();
  const sections = [
    createBasicSection(ctx, b, d),
    createToneCurveSection(ctx, b, d),
    createColorMixerSection(ctx, b, d),
    createColorGradingSection(ctx, b, d),
    createDetailSection(ctx, b, d),
    createOpticsSection(ctx, b, d),
    createGeometrySection(ctx, b, d),
    createEffectsSection(ctx, b, d),
    createCalibrationSection(ctx, b, d),
  ];
  const el = h('div', { class: 'k-pnl-edit' }, ...sections.map((s) => s.el));
  return {
    el,
    dispose() {
      for (const s of sections) s.destroy();
      d.dispose();
    },
  };
}

export function createDevelopRightPanel(ctx: AppContext): { el: HTMLElement; dispose(): void } {
  const d = new Disposer();
  const b = new DocBinder(ctx);
  d.add(() => b.dispose());
  const hist = createHistogramBlock(ctx);
  d.add(() => hist.dispose());
  const body = h('div', { class: 'k-pnl__scroll' });
  const toolBar = h('div', { class: 'k-pnl__tools', attrs: { role: 'toolbar', 'aria-label': 'Develop tools' } });
  const buttons = TOOLS.map((t) => {
    const btn = createIconButton({
      icon: t.icon,
      label: t.label,
      shortcut: t.key,
      pressed: ctx.tool.value === t.id,
      onClick: () => ctx.tool.set(t.id),
    });
    toolBar.append(btn.el);
    d.add(() => btn.destroy());
    return { id: t.id, btn };
  });
  const more = createIconButton({ icon: 'more-horizontal', label: 'Develop actions', onClick: () => openDevelopMenu(ctx, more.el) });
  d.add(() => more.destroy());
  toolBar.append(more.el);
  const el = h('aside', { class: 'k-pnl k-pnl-right', attrs: { 'aria-label': 'Develop panel' } }, hist.el, toolBar, body);

  let current: ToolPanel | null = null;
  let currentTool: DevelopTool | null = null;
  const show = () => {
    const doc = ctx.doc.value;
    const tool = ctx.tool.value;
    for (const { id, btn } of buttons) btn.setPressed(id === tool);
    if (current && currentTool === tool && doc) return;
    current?.dispose();
    current = null;
    clear(body);
    currentTool = tool;
    if (!doc) {
      body.append(h('div', { class: 'k-pnl__empty' }, 'Open a photo from the library to start editing.'));
      currentTool = null;
      return;
    }
    const make = { edit: createEditPanel, crop: createCropPanel, heal: createHealPanel, masks: createMasksPanel, ai: createAiPanel }[tool];
    current = make(ctx, b);
    body.append(current.el);
  };
  d.add(ctx.tool.subscribe(show));
  d.add(b.onDoc(show));
  d.add(() => current?.dispose());
  return { el, dispose: () => d.dispose() };
}

export function registerPanelCommands(ctx: AppContext): () => void {
  const d = new Disposer();
  const inDevelop = () => ctx.module.value === 'develop' && !!ctx.doc.value;
  d.add(ctx.commands.register({ id: 'develop.autoTone', label: 'Auto tone', keys: ['Shift+Mod+U'], group: 'Develop', when: inDevelop, run: () => void applyAutoTone(ctx) }));
  d.add(
    ctx.commands.register({
      id: 'develop.wbPicker',
      label: 'White balance selector',
      keys: ['W'],
      group: 'Develop',
      when: inDevelop,
      run: () => ctx.wbPickerActive.set(!ctx.wbPickerActive.value),
    }),
  );
  d.add(
    ctx.commands.register({
      id: 'develop.newSnapshot',
      label: 'New snapshot',
      keys: ['Shift+Mod+N'],
      group: 'Develop',
      when: inDevelop,
      run: async () => {
        const store = ctx.doc.value?.store;
        if (!store) return;
        const name = await ctx.prompt({ title: 'New snapshot', value: `Snapshot ${store.snapshots.length + 1}`, confirmLabel: 'Save' });
        if (name) store.createSnapshot(name.trim());
      },
    }),
  );
  d.add(
    ctx.commands.register({
      id: 'develop.resetAll',
      label: 'Reset all settings',
      keys: ['Shift+Mod+R'],
      group: 'Develop',
      when: inDevelop,
      run: () => ctx.doc.value?.store.reset('Reset All'),
    }),
  );
  d.add(ctx.commands.register({ id: 'develop.toolEdit', label: 'Edit panel', keys: ['E'], group: 'Develop', when: inDevelop, run: () => ctx.tool.set('edit') }));
  d.add(ctx.commands.register({ id: 'develop.toolAi', label: 'AI panel', keys: ['A'], group: 'Develop', when: inDevelop, run: () => ctx.tool.set('ai') }));
  return () => d.dispose();
}
