/**
 * Develop panels: the right panel (histogram, tool strip, tool panels) and
 * the left panel (navigator, presets, snapshots, history).
 */
import './panels.css';
import type { AppContext, DevelopTool } from '../../app/context';
import { clear, Disposer, h, on } from '../dom';
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
  const groups = [
    { label: 'Light', section: createBasicSection(ctx, b, d) },
    { label: 'Curve', section: createToneCurveSection(ctx, b, d) },
    { label: 'Color', section: createColorMixerSection(ctx, b, d) },
    { label: 'Grade', section: createColorGradingSection(ctx, b, d) },
    { label: 'Detail', section: createDetailSection(ctx, b, d) },
    { label: 'Optics', section: createOpticsSection(ctx, b, d) },
    { label: 'Geometry', section: createGeometrySection(ctx, b, d) },
    { label: 'Effects', section: createEffectsSection(ctx, b, d) },
    { label: 'Calibrate', section: createCalibrationSection(ctx, b, d) },
  ];
  const sections = groups.map((group) => group.section);
  let active = 0;
  const navButtons = groups.map((group, index) =>
    h(
      'button',
      {
        type: 'button',
        class: ['k-pnl-editnav__button', index === active && 'is-active'],
        onclick: () => {
          active = index;
          navButtons.forEach((button, i) => button.classList.toggle('is-active', i === index));
          sections.forEach((section, i) => section.setOpen(i === index));
          requestAnimationFrame(() => group.section.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        },
      },
      group.label,
    ),
  );
  const mobileNav = h('nav', { class: 'k-pnl-editnav', attrs: { 'aria-label': 'Adjustment groups' } }, ...navButtons);
  const el = h('div', { class: 'k-pnl-edit' }, mobileNav, ...sections.map((s) => s.el));
  return {
    el,
    dispose() {
      for (const s of sections) s.destroy();
      d.dispose();
    },
  };
}

export interface DevelopRightPanelOptions {
  /** Phone sheet close action. Ignored by the desktop layout. */
  onMobileClose?: () => void;
}

export function createDevelopRightPanel(ctx: AppContext, opts: DevelopRightPanelOptions = {}): { el: HTMLElement; dispose(): void } {
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

  /* Phone sheet furniture. It remains hidden and inert in desktop layouts. */
  const mobileTitle = h('strong', { class: 'k-pnl__mobile-title' }, 'Adjust');
  const grab = h(
    'button',
    { type: 'button', class: 'k-pnl__mobile-grab', attrs: { 'aria-label': 'Resize develop panel', 'aria-expanded': 'false' } },
    h('span', { class: 'k-pnl__mobile-grabber', attrs: { 'aria-hidden': 'true' } }),
  );
  const histToggle = createIconButton({
    icon: 'bar-chart',
    label: 'Show histogram',
    size: 'lg',
    pressed: false,
    autoToggle: false,
    tooltip: false,
  });
  const expand = createIconButton({ icon: 'chevron-up', label: 'Expand panel', size: 'lg', tooltip: false });
  const close = createIconButton({ icon: 'x', label: 'Close panel', size: 'lg', tooltip: false, onClick: () => opts.onMobileClose?.() });
  d.add(() => [histToggle, expand, close].forEach((item) => item.destroy()));
  const mobileHead = h(
    'div',
    { class: 'k-pnl__mobile-head' },
    grab,
    h('div', { class: 'k-pnl__mobile-headrow' }, mobileTitle, h('span', { class: 'k-pnl__mobile-actions' }, histToggle.el, expand.el, close.el)),
  );
  const el = h(
    'aside',
    { id: 'kloud-mobile-develop-sheet', class: 'k-pnl k-pnl-right', attrs: { 'aria-label': 'Develop panel' }, dataset: { mobileSnap: 'half' } },
    mobileHead,
    hist.el,
    toolBar,
    body,
  );

  type Snap = 'compact' | 'half' | 'full';
  const setSnap = (snap: Snap): void => {
    el.dataset.mobileSnap = snap;
    el.style.removeProperty('--k-mobile-sheet-height');
    const full = snap === 'full';
    grab.setAttribute('aria-expanded', String(full));
    expand.setIcon(full ? 'chevron-down' : 'chevron-up');
    expand.setLabel(full ? 'Reduce panel' : 'Expand panel');
  };
  const toggleSnap = (): void => setSnap(el.dataset.mobileSnap === 'full' ? 'half' : 'full');
  expand.el.addEventListener('click', toggleSnap);
  d.add(() => expand.el.removeEventListener('click', toggleSnap));
  histToggle.el.addEventListener('click', () => {
    const open = !el.classList.contains('is-mobile-hist-open');
    el.classList.toggle('is-mobile-hist-open', open);
    histToggle.setPressed(open);
    histToggle.setLabel(open ? 'Hide histogram' : 'Show histogram');
  });

  let pointer = -1;
  let startY = 0;
  let startHeight = 0;
  let moved = false;
  d.add(
    on(grab, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      pointer = event.pointerId;
      startY = event.clientY;
      startHeight = el.getBoundingClientRect().height;
      moved = false;
      grab.setPointerCapture(pointer);
      el.classList.add('is-mobile-resizing');
      event.preventDefault();
    }),
  );
  d.add(
    on(grab, 'pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > 5) moved = true;
      const available = el.parentElement?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
      const height = Math.max(150, Math.min(available - 8, startHeight - dy));
      el.style.setProperty('--k-mobile-sheet-height', `${height}px`);
      el.dataset.mobileSnap = 'custom';
    }),
  );
  const endResize = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return;
    pointer = -1;
    el.classList.remove('is-mobile-resizing');
    const available = el.parentElement?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const ratio = el.getBoundingClientRect().height / Math.max(1, available);
    if (moved && ratio < 0.26) {
      opts.onMobileClose?.();
      setSnap('half');
    } else if (ratio < 0.5) setSnap('compact');
    else if (ratio < 0.76) setSnap('half');
    else setSnap('full');
  };
  d.add(on(grab, 'pointerup', endResize));
  d.add(on(grab, 'pointercancel', endResize));
  d.add(
    on(grab, 'click', () => {
      if (moved) {
        moved = false;
        return;
      }
      toggleSnap();
    }),
  );

  let current: ToolPanel | null = null;
  let currentTool: DevelopTool | null = null;
  const show = () => {
    const doc = ctx.doc.value;
    const tool = ctx.tool.value;
    mobileTitle.textContent = TOOLS.find((item) => item.id === tool)?.label ?? 'Develop';
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
