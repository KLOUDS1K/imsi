/**
 * UI kit gallery — renders every component in a kloud.photography-style shell.
 * Used by ui-kit.spec.ts (screenshots + interaction checks) and as a living
 * reference for the other UI modules. window.__kit exposes an event log.
 */
import { h } from '@/ui/dom';
import {
  ICON_NAMES,
  attachContextMenu,
  attachMenu,
  attachTooltip,
  bandHueGradient,
  confirmDialog,
  createBadge,
  createBottomSheet,
  createBreadcrumb,
  createBusyLine,
  createButton,
  createCheckbox,
  createColorInput,
  createColorLabelPicker,
  createDrawer,
  createEmptyState,
  createFlagToggle,
  createFolderTile,
  createGradeWheelControl,
  createIconButton,
  createKbd,
  createNavArrows,
  createNavItem,
  createNumberInput,
  createProgressBar,
  createRadioGroup,
  createRangeSlider,
  createRatingStars,
  createSearchInput,
  createSection,
  createSectionLabel,
  createSegmentedControl,
  createSelect,
  createSlider,
  createSpinner,
  createSplitter,
  createStatusBar,
  createSwatch,
  createTabs,
  createTextInput,
  createThemeToggle,
  createToaster,
  createToggle,
  createToolbar,
  createWordmark,
  greyGradient,
  hueGradient,
  icon,
  luminanceGradient,
  onThemeChange,
  openDialog,
  promptDialog,
  resolvedTheme,
  saturationGradient,
  temperatureGradient,
  tintGradient,
  toolbarDivider,
  toolbarGroup,
  toolbarSpacer,
  type MenuItem,
} from '@/ui/kit';

interface KitLog {
  events: string[];
  slider: { input: number[]; change: number[]; gestures: number };
  lastMenu: string | null;
  rating: number;
  confirm: boolean | null;
  prompt: string | null | undefined;
}
const log: KitLog = { events: [], slider: { input: [], change: [], gestures: 0 }, lastMenu: null, rating: 0, confirm: null, prompt: undefined };
(window as unknown as { __kit: KitLog }).__kit = log;
const note = (s: string): void => {
  log.events.push(s);
  logEl.textContent = s;
};

const root = document.getElementById('app')!;
const toaster = createToaster();
const busy = createBusyLine();
const logEl = h('div', { class: 'g-log', attrs: { 'data-testid': 'log' } });

/* ------------------------------------------------------------------ */
/* Toolbar (site chrome)                                              */
/* ------------------------------------------------------------------ */

const menuBtn = createIconButton({ icon: 'menu', label: 'Sections', class: 'g-menu-btn', onClick: () => drawer.open() });
const view = createSegmentedControl({
  ariaLabel: 'View',
  value: 'grid',
  size: 'sm',
  options: [
    { value: 'grid', icon: 'grid', title: 'Grid' },
    { value: 'list', icon: 'list', title: 'List' },
  ],
  onChange: (v) => note(`view:${v}`),
});
const sortBtn = createIconButton({ icon: 'arrow-up-down', label: 'Sort' });
attachMenu(sortBtn.el, () => [
  { kind: 'header', label: 'Sort by' },
  { label: 'Name', checked: true, onSelect: () => note('sort:name') },
  { label: 'Capture date', checked: false, onSelect: () => note('sort:date') },
  { label: 'Rating', checked: false, onSelect: () => note('sort:rating') },
]);
const toolbar = createToolbar({
  children: [
    menuBtn.el,
    h('span', { class: 'g-hide-sm' }, createNavArrows({ onBack: () => note('back'), onForward: () => note('forward'), onUp: () => note('up') }).el),
    createBreadcrumb([{ label: 'Archive', onClick: () => note('crumb') }, { label: 'UI Kit' }]).el,
    toolbarSpacer(),
    createSearchInput({ onInput: (v) => note(`search:${v}`), width: 'min(200px, 34vw)' }).el,
    toolbarGroup(view.el, sortBtn.el, createThemeToggle({ onChange: (t) => note(`theme:${t}`) }).el),
    h('span', { class: 'g-hide-sm' }, createIconButton({ icon: 'lock', label: 'Lock' }).el),
  ],
});
toolbar.append(busy.el);

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

const navDefs: [string, Parameters<typeof icon>[0]][] = [
  ['Folders', 'folder'],
  ['Develop', 'develop'],
  ['Controls', 'sliders'],
  ['Library', 'library'],
  ['Overlays', 'layers'],
  ['Icons', 'sparkles'],
];
const makeNav = (): HTMLElement =>
  h(
    'nav',
    { class: 'g-sidebar__nav', attrs: { 'aria-label': 'Gallery sections' } },
    ...navDefs.map(([label, ic], i) =>
      createNavItem({
        label,
        icon: ic,
        active: i === 0,
        onClick: () => document.getElementById(`g-${label.toLowerCase()}`)?.scrollIntoView({ behavior: 'smooth' }),
      }).el,
    ),
  );
const sidebar = h(
  'aside',
  { class: 'g-sidebar' },
  h('div', { class: 'g-sidebar__top' }, createWordmark()),
  makeNav(),
  h('div', { class: 'g-sidebar__foot' }, `${navDefs.length} sections`),
);
const drawer = createDrawer({ side: 'left', label: 'Sections', content: [h('div', { class: 'g-sidebar__top' }, createWordmark()), makeNav()] });

/* ------------------------------------------------------------------ */
/* Content                                                            */
/* ------------------------------------------------------------------ */

const block = (id: string, label: string, count: number | undefined, ...children: (Node | null)[]): HTMLElement =>
  h('section', { class: 'g-block', id: `g-${id}` }, createSectionLabel(label, count), ...children);

// Folders — exactly like the site's archive.
const folders = block(
  'folders',
  'Folders',
  4,
  h(
    'div',
    { class: 'g-folders' },
    createFolderTile({ name: 'NS apex', sub: 'Locked', glyph: 'lock', nameIcon: 'lock-small', onOpen: () => note('folder:ns') }).el,
    createFolderTile({ name: '풀약셀', sub: 'Locked', glyph: 'lock', nameIcon: 'lock-small' }).el,
    createFolderTile({ name: 'Seoul Night', sub: '128 photos', size: 'md' }).el,
    createFolderTile({ name: 'New folder', sub: 'Empty', glyph: 'folder-plus', size: 'sm' }).el,
  ),
);

/* ---- Develop panel ---- */

const slider = (label: string, min: number, max: number, extra: Partial<Parameters<typeof createSlider>[0]> = {}) =>
  createSlider({ label, min, max, ...extra }).el;

const exposure = createSlider({
  label: 'Exposure',
  min: -5,
  max: 5,
  step: 0.05,
  fineStep: 0.01,
  decimals: 2,
  value: 0,
  id: 'exposure',
  onGestureStart: () => log.slider.gestures++,
  onInput: (v) => log.slider.input.push(v),
  onChange: (v) => {
    log.slider.change.push(v);
    note(`exposure:${v}`);
  },
});

const light = createSection({
  id: 'gallery.light',
  title: 'Light',
  open: true,
  persist: false,
  onReset: () => note('reset:light'),
  content: [
    exposure.el,
    slider('Contrast', -100, 100, { value: 18 }),
    slider('Highlights', -100, 100, { value: -42 }),
    slider('Shadows', -100, 100, { value: 35 }),
    slider('Whites', -100, 100),
    slider('Blacks', -100, 100),
  ],
});
light.setModified(true);

const wb = createSection({
  id: 'gallery.wb',
  title: 'White balance',
  persist: false,
  content: [
    slider('Temp', -100, 100, { gradient: temperatureGradient(), value: 12 }),
    slider('Tint', -100, 100, { gradient: tintGradient(), value: -4 }),
    slider('Vibrance', -100, 100, { value: 20 }),
    slider('Saturation', -100, 100, { gradient: saturationGradient(30) }),
  ],
});

const hsl = createSection({
  id: 'gallery.hsl',
  title: 'Color mixer',
  persist: false,
  badge: 'HSL',
  content: [
    slider('Hue', -100, 100, { gradient: bandHueGradient(30), value: 8 }),
    slider('Saturation', -100, 100, { gradient: saturationGradient(30), value: -12 }),
    slider('Luminance', -100, 100, { gradient: luminanceGradient(30) }),
  ],
});

const grading = createSection({
  id: 'gallery.grading',
  title: 'Color grading',
  persist: false,
  content: [
    h(
      'div',
      { class: 'g-wheels' },
      createGradeWheelControl({ label: 'Midtones', size: 132, value: { hue: 28, saturation: 22, luminance: 0 }, onInput: (v) => note(`mid:${Math.round(v.hue)}/${Math.round(v.saturation)}`) }).el,
      createGradeWheelControl({ label: 'Shadows', size: 104, value: { hue: 212, saturation: 30, luminance: -10 } }).el,
      createGradeWheelControl({ label: 'Highlights', size: 104, value: { hue: 45, saturation: 16, luminance: 6 } }).el,
    ),
    slider('Blending', 0, 100, { defaultValue: 50, value: 50 }),
    slider('Balance', -100, 100),
  ],
});

const detail = createSection({
  id: 'gallery.detail',
  title: 'Detail',
  persist: false,
  enabled: true,
  onEnabledChange: (b) => note(`detail:${b}`),
  content: [
    slider('Sharpening', 0, 150, { defaultValue: 40, value: 40, fill: 'min' }),
    slider('Radius', 0.5, 3, { step: 0.1, defaultValue: 1, value: 1.4 }),
    slider('Noise reduction', 0, 100, { value: 25, fill: 'min' }),
    slider('Rotate', -45, 45, { step: 0.1, unit: '°', value: -1.3 }),
  ],
});

const masks = createSection({
  id: 'gallery.range',
  title: 'Range mask',
  persist: false,
  open: false,
  content: [
    createRangeSlider({ label: 'Luminance range', min: 0, max: 100, value: [22, 78], gradient: greyGradient() }).el,
    createRangeSlider({ label: 'Purple hue', min: 0, max: 360, value: [270, 330], unit: '°', gradient: hueGradient() }).el,
    createRangeSlider({ label: 'Depth', min: 0, max: 100, value: [0, 60] }).el,
  ],
});

const panel = h(
  'div',
  { class: 'g-panel', attrs: { 'data-testid': 'panel' } },
  h('div', { class: 'g-panel__title' }, h('span', { class: 'k-label' }, 'Edit'), createBadge('Heuristic', { tone: 'outline', title: 'Classical algorithm — no ML model' }).el),
  light.el,
  wb.el,
  hsl.el,
  grading.el,
  detail.el,
  masks.el,
);

const scopes = createTabs({
  ariaLabel: 'Scopes',
  value: 'histogram',
  tabs: [
    { id: 'histogram', label: 'Histogram', panel: h('div', { class: 'g-log' }, 'Histogram panel') },
    { id: 'waveform', label: 'Waveform', panel: h('div', { class: 'g-log' }, 'Waveform panel') },
    { id: 'vectorscope', label: 'Vector', panel: h('div', { class: 'g-log' }, 'Vectorscope panel') },
  ],
  onChange: (id) => note(`tab:${id}`),
});
const tools = createTabs({
  ariaLabel: 'Tools',
  variant: 'pill',
  stretch: true,
  value: 'edit',
  tabs: [
    { id: 'edit', icon: 'sliders', title: 'Edit' },
    { id: 'crop', icon: 'crop', title: 'Crop' },
    { id: 'heal', icon: 'bandage', title: 'Remove' },
    { id: 'masks', icon: 'radial', title: 'Masks', badge: 2 },
    { id: 'ai', icon: 'sparkles', title: 'AI' },
  ],
});

const develop = block(
  'develop',
  'Develop',
  undefined,
  h(
    'div',
    { class: 'g-develop' },
    panel,
    createSplitter({ target: panel, edge: 'end', min: 260, max: 480, defaultSize: 312, label: 'Resize edit panel', onResizeEnd: (w) => note(`panel:${w}`) }).el,
    h('div', { class: 'g-card', style: 'width: var(--k-panel-w); max-width: 100%' }, h('span', { class: 'k-label' }, 'Tabs'), tools.el, scopes.el),
  ),
);

/* ---- Controls ---- */

const card = (label: string, ...children: (Node | null)[]): HTMLElement => h('div', { class: 'g-card' }, h('span', { class: 'k-label' }, label), ...children);
const rating = createRatingStars({
  value: 3,
  onChange: (v) => {
    log.rating = v;
    note(`rating:${v}`);
  },
});
log.rating = 3;
const uiState = createProgressBar({ label: 'Exporting 3 of 12', showValue: true, value: 0.42 });

const controls = block(
  'controls',
  'Controls',
  undefined,
  h(
    'div',
    { class: 'g-grid' },
    card(
      'Buttons',
      h(
        'div',
        { class: 'g-row' },
        createButton({ label: 'Export', variant: 'primary', icon: 'download' }).el,
        createButton({ label: 'Cancel' }).el,
        createButton({ label: 'Ghost', variant: 'ghost' }).el,
        createButton({ label: 'Delete', variant: 'danger', icon: 'trash' }).el,
      ),
      h(
        'div',
        { class: 'g-row' },
        createButton({ label: 'Small', size: 'sm' }).el,
        createButton({ label: 'Primary', size: 'sm', variant: 'primary' }).el,
        (() => {
          const b = createButton({ label: 'Saving', size: 'sm' });
          b.setBusy(true);
          return b.el;
        })(),
        createButton({ label: 'Disabled', size: 'sm', disabled: true }).el,
      ),
    ),
    card(
      'Icon buttons',
      h(
        'div',
        { class: 'g-row' },
        createIconButton({ icon: 'undo', label: 'Undo', shortcut: 'Mod+Z' }).el,
        createIconButton({ icon: 'redo', label: 'Redo', shortcut: 'Shift+Mod+Z' }).el,
        createIconButton({ icon: 'compare', label: 'Before / after', shortcut: '\\', pressed: false }).el,
        createIconButton({ icon: 'eye', label: 'Show overlay', pressed: true }).el,
        createIconButton({ icon: 'zoom-in', label: 'Zoom in', size: 'sm' }).el,
        createIconButton({ icon: 'fullscreen', label: 'Full screen', size: 'lg', variant: 'raised' }).el,
      ),
      h(
        'div',
        { class: 'g-row' },
        createSegmentedControl({
          ariaLabel: 'Compare',
          value: 'split',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'split', label: 'Split', icon: 'split-v' },
            { value: 'side', label: 'Side by side' },
          ],
        }).el,
      ),
    ),
    card(
      'Toggles',
      h('div', { class: 'g-row' }, createToggle({ label: 'Show clipping', checked: true }).el, createToggle({ label: 'Auto mask' }).el),
      h('div', { class: 'g-row' }, createCheckbox({ label: 'Include metadata', checked: true }).el, createCheckbox({ label: 'Sharpen', indeterminate: true }).el),
      createRadioGroup({
        ariaLabel: 'Resize',
        orientation: 'horizontal',
        value: 'long',
        options: [
          { value: 'none', label: 'Original' },
          { value: 'long', label: 'Long edge' },
          { value: 'mp', label: 'Megapixels' },
        ],
      }).el,
    ),
    card(
      'Fields',
      h(
        'div',
        { class: 'g-row' },
        createSelect({
          ariaLabel: 'Format',
          value: 'jpeg',
          options: [
            { value: 'jpeg', label: 'JPEG' },
            { value: 'png', label: 'PNG' },
            { group: 'Lossless', options: [{ value: 'tiff', label: 'TIFF 16-bit' }, { value: 'dng', label: 'DNG' }] },
          ],
        }).el,
        createNumberInput({ value: 2048, min: 16, max: 16384, unit: 'px', ariaLabel: 'Long edge' }).el,
      ),
      createTextInput({ label: 'File name', value: '{name}-{seq}', placeholder: 'Template' }).el,
      createSearchInput({ width: '100%' }).el,
    ),
    card(
      'Library',
      h('div', { class: 'g-row', attrs: { 'data-testid': 'rating' } }, rating.el, createFlagToggle({ value: 'pick' }).el),
      createColorLabelPicker({ value: 'yellow' }).el,
      h('div', { class: 'g-row' }, createRatingStars({ value: 4, readonly: true, size: 11 }).el, createBadge(12).el, createBadge('Edited', { tone: 'accent' }).el, createBadge('On-device model', { tone: 'outline' }).el),
    ),
    card(
      'Keys & colour',
      h('div', { class: 'g-row' }, createKbd('Shift+Mod+Z').el, createKbd('\\').el, createKbd('ArrowRight').el, h('span', { class: 'k-muted k-small' }, 'hold'), createKbd('Space').el),
      h(
        'div',
        { class: 'g-row' },
        createSwatch({ color: 'rgba(255, 64, 64, 0.8)', label: 'Red overlay', selected: true }).el,
        createSwatch({ color: 'rgba(64, 160, 255, 0.8)', label: 'Blue overlay', selected: false }).el,
        createSwatch({ color: 'rgba(64, 220, 120, 0.8)', label: 'Green overlay', shape: 'circle' }).el,
        createColorInput({ value: '#f2c230', ariaLabel: 'Watermark colour' }).el,
      ),
    ),
    card('Progress', uiState.el, createProgressBar({ size: 'sm', value: null }).el, h('div', { class: 'g-row k-muted k-small' }, createSpinner({ size: 14 }).el, 'Rendering preview…')),
  ),
);

/* ---- Library empty state ---- */

const library = block(
  'library',
  'Library',
  0,
  h(
    'div',
    { class: 'g-card' },
    createEmptyState({
      title: 'No photos yet',
      description: 'Import a folder of photos to start editing. Originals never leave your device.',
      glyph: 'plus',
      actions: [createButton({ label: 'Import photos', variant: 'primary', icon: 'upload' }).el, createButton({ label: 'Open folder', icon: 'folder' }).el],
    }).el,
  ),
);

/* ---- Overlays ---- */

const menuItems = (): MenuItem[] => [
  { label: 'Copy settings…', icon: 'copy', shortcut: 'Shift+Mod+C', onSelect: () => (log.lastMenu = 'copy') },
  { label: 'Paste settings', icon: 'clipboard', shortcut: 'Shift+Mod+V', onSelect: () => (log.lastMenu = 'paste') },
  { kind: 'separator' },
  {
    label: 'Sort by',
    icon: 'arrow-up-down',
    submenu: [
      { label: 'Name', checked: true, onSelect: () => (log.lastMenu = 'sort-name') },
      { label: 'Date', checked: false, onSelect: () => (log.lastMenu = 'sort-date') },
    ],
  },
  { label: 'Export…', icon: 'export', shortcut: 'Shift+Mod+E', onSelect: () => (log.lastMenu = 'export') },
  { kind: 'separator' },
  { label: 'Remove from library', icon: 'trash', danger: true, onSelect: () => (log.lastMenu = 'remove') },
];

const menuButton = createButton({ label: 'Menu', iconRight: 'chevron-down', class: 'g-menu-trigger' });
attachMenu(menuButton.el, menuItems, { onSelect: (item) => note(`menu:${item.label}`) });
const ctxArea = h('div', { class: 'g-ctx', attrs: { 'data-testid': 'ctx' } }, 'Right-click or long-press here');
attachContextMenu(ctxArea, () => menuItems());
const tipTarget = createButton({ label: 'Hover for tooltip', variant: 'ghost', size: 'sm' });
attachTooltip(tipTarget.el, 'Tooltips are delayed and touch-friendly', { shortcut: 'Mod+/' });

const sheetBody = h(
  'div',
  { style: 'padding: 4px 16px 16px' },
  createSection({ id: 'gallery.sheet', title: 'Light', persist: false, content: [slider('Exposure', -5, 5, { step: 0.05, decimals: 2 }), slider('Contrast', -100, 100)] }).el,
);
const sheet = createBottomSheet({
  label: 'Edit',
  content: sheetBody,
  header: h('div', { style: 'padding: 0 16px 8px', class: 'k-label' }, 'Edit'),
  onSnap: (i) => note(`sheet:${i}`),
  onClose: () => note('sheet:closed'),
});

let busyOn = false;
const overlays = block(
  'overlays',
  'Overlays',
  undefined,
  h(
    'div',
    { class: 'g-grid' },
    card(
      'Dialogs',
      h(
        'div',
        { class: 'g-row' },
        createButton({
          label: 'Confirm',
          class: 'g-open-confirm',
          onClick: async () => {
            log.confirm = await confirmDialog({ title: 'Delete 3 photos?', message: 'The originals stay on your disk. Edits are removed.', confirmLabel: 'Delete', danger: true });
            note(`confirm:${log.confirm}`);
          },
        }).el,
        createButton({
          label: 'Prompt',
          class: 'g-open-prompt',
          onClick: async () => {
            log.prompt = await promptDialog({ title: 'New preset', label: 'Name', value: 'Seoul night' });
            note(`prompt:${log.prompt}`);
          },
        }).el,
        createButton({
          label: 'Dialog',
          onClick: () =>
            openDialog({
              title: 'Export 12 photos',
              description: 'JPEG · sRGB · long edge 2048 px',
              content: createProgressBar({ label: 'Preparing', showValue: true, value: 0.2 }).el,
              actions: [
                { label: 'Cancel', value: 'cancel', variant: 'ghost' },
                { label: 'Export', value: 'export', variant: 'primary', autofocus: true },
              ],
            }),
        }).el,
      ),
    ),
    card('Menus', h('div', { class: 'g-row' }, menuButton.el, tipTarget.el), ctxArea),
    card(
      'Feedback',
      h(
        'div',
        { class: 'g-row' },
        createButton({ label: 'Toast', onClick: () => toaster.show('Exported 12 photos', 'success') }).el,
        createButton({ label: 'Error', onClick: () => toaster.show('Could not decode IMG_0042.CR3', 'error') }).el,
        createButton({
          label: 'Busy',
          onClick: () => {
            busyOn = !busyOn;
            busy.set({ active: busyOn });
          },
        }).el,
      ),
      h('div', { class: 'g-row' }, createButton({ label: 'Drawer', icon: 'sidebar', onClick: () => drawer.open() }).el, createButton({ label: 'Bottom sheet', icon: 'panel-bottom', onClick: () => sheet.open(1) }).el),
    ),
  ),
);

/* ---- Icons ---- */

const icons = block(
  'icons',
  'Icons',
  ICON_NAMES.length,
  h(
    'div',
    { class: 'g-icons' },
    ...ICON_NAMES.map((n) => h('div', { class: 'g-icon', title: n }, icon(n, 20), h('span', null, n))),
  ),
);

const main = h(
  'main',
  { class: 'g-main' },
  h('header', { class: 'g-head' }, h('h1', { class: 'k-h1' }, 'UI Kit'), h('p', { class: 'k-desc' }, 'Every component of KLOUD Studio, drawn in the archive’s language. Toggle the theme from the toolbar.'), logEl),
  folders,
  develop,
  controls,
  library,
  overlays,
  icons,
);

const status = createStatusBar(h('span', null, `${ICON_NAMES.length} icons`), h('span', { attrs: { 'data-testid': 'theme' } }, `Theme: ${resolvedTheme()}`));
onThemeChange((t) => {
  status.lastElementChild!.textContent = `Theme: ${t}`;
});

root.append(toolbar, h('div', { class: 'g-body' }, sidebar, main), status);
document.documentElement.dataset.galleryReady = '1';
