/**
 * Settings-group checklist used by Copy Settings, Sync Settings and the
 * paste/preset flows: categories with tri-state headers plus quick-preset
 * chips ("Exposure sync", "Color sync", "Crop sync", "Mask sync", "All",
 * "Selective").
 */
import { SETTINGS_GROUPS, type SettingsGroup } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { createCheckbox, type Checkbox } from '@/ui/kit';

export const GROUP_LABELS: Record<SettingsGroup, string> = {
  exposure: 'Exposure',
  tone: 'Contrast, Highlights, Shadows, Whites, Blacks',
  whiteBalance: 'White Balance',
  color: 'Vibrance & Saturation',
  hsl: 'Color Mixer (HSL)',
  toneCurve: 'Tone Curve',
  colorGrading: 'Color Grading',
  calibration: 'Calibration',
  presence: 'Texture, Clarity, Dehaze',
  detail: 'Sharpening',
  noise: 'Noise Reduction',
  lens: 'Lens Corrections',
  transform: 'Transform',
  crop: 'Crop & Straighten',
  effects: 'Vignette, Grain, Glow',
  masks: 'Masks',
  retouch: 'Heal & Remove',
};

export const GROUP_CATEGORIES: { title: string; groups: SettingsGroup[] }[] = [
  { title: 'Light', groups: ['exposure', 'tone', 'toneCurve'] },
  { title: 'Color', groups: ['whiteBalance', 'color', 'hsl', 'colorGrading', 'calibration'] },
  { title: 'Detail & Presence', groups: ['presence', 'detail', 'noise'] },
  { title: 'Optics & Geometry', groups: ['lens', 'transform', 'crop'] },
  { title: 'Effects & Local', groups: ['effects', 'masks', 'retouch'] },
];

export type QuickPresetId = 'exposure' | 'color' | 'crop' | 'mask' | 'all' | 'selective';
export const QUICK_PRESETS: { id: QuickPresetId; label: string; groups: SettingsGroup[] | null }[] = [
  { id: 'exposure', label: 'Exposure sync', groups: ['exposure'] },
  { id: 'color', label: 'Color sync', groups: ['whiteBalance', 'color', 'hsl', 'colorGrading', 'calibration'] },
  { id: 'crop', label: 'Crop sync', groups: ['crop'] },
  { id: 'mask', label: 'Mask sync', groups: ['masks'] },
  { id: 'all', label: 'All', groups: [...SETTINGS_GROUPS] },
  // Selective = start from nothing and tick groups by hand.
  { id: 'selective', label: 'Selective', groups: null },
];

/** Groups a sync should include by default: whatever the source changed, minus crop and retouching (Lightroom's default). */
export function defaultSyncGroups(modified: SettingsGroup[]): SettingsGroup[] {
  const g = modified.filter((x) => x !== 'crop' && x !== 'retouch');
  return g.length > 0 ? g : SETTINGS_GROUPS.filter((x) => x !== 'crop' && x !== 'retouch' && x !== 'masks');
}

export interface GroupChecklist {
  el: HTMLElement;
  get(): SettingsGroup[];
  set(groups: SettingsGroup[]): void;
  onChange(cb: (groups: SettingsGroup[]) => void): void;
  destroy(): void;
}

export function createGroupChecklist(opts: { value: SettingsGroup[]; modified?: SettingsGroup[]; quickPresets?: boolean }): GroupChecklist {
  const d = new Disposer();
  const selected = new Set<SettingsGroup>(opts.value);
  const modified = new Set(opts.modified ?? []);
  const boxes = new Map<SettingsGroup, Checkbox>();
  const headers: { cat: (typeof GROUP_CATEGORIES)[number]; box: Checkbox }[] = [];
  const chips = new Map<QuickPresetId, HTMLButtonElement>();
  let listener: ((g: SettingsGroup[]) => void) | null = null;

  const list = (): SettingsGroup[] => SETTINGS_GROUPS.filter((g) => selected.has(g));

  const sync = (): void => {
    for (const [g, box] of boxes) box.setChecked(selected.has(g), true);
    for (const { cat, box } of headers) {
      const n = cat.groups.filter((g) => selected.has(g)).length;
      box.setChecked(n === cat.groups.length, true);
      box.setIndeterminate(n > 0 && n < cat.groups.length);
    }
    const cur = list();
    for (const p of QUICK_PRESETS) {
      const chip = chips.get(p.id);
      if (!chip) continue;
      const match = p.groups ? p.groups.length === cur.length && p.groups.every((g) => selected.has(g)) : false;
      chip.setAttribute('aria-pressed', String(match));
    }
    const anyMatch = [...chips.values()].some((c) => c.getAttribute('aria-pressed') === 'true');
    chips.get('selective')?.setAttribute('aria-pressed', String(!anyMatch));
  };
  const changed = (): void => {
    sync();
    listener?.(list());
  };

  const chipRow = h('div', { class: 'k-batch-chips', attrs: { role: 'group', 'aria-label': 'Quick selections' } });
  if (opts.quickPresets !== false) {
    for (const p of QUICK_PRESETS) {
      const chip = h('button', { type: 'button', class: 'k-batch-chip', attrs: { 'aria-pressed': 'false' }, dataset: { preset: p.id } }, p.label);
      d.add(
        on(chip, 'click', () => {
          selected.clear();
          for (const g of p.groups ?? []) selected.add(g);
          changed();
        }),
      );
      chips.set(p.id, chip);
      chipRow.append(chip);
    }
  }

  const grid = h('div', { class: 'k-batch-groups' });
  for (const cat of GROUP_CATEGORIES) {
    const head = createCheckbox({
      label: cat.title,
      onChange: (checked) => {
        for (const g of cat.groups) {
          if (checked) selected.add(g);
          else selected.delete(g);
        }
        changed();
      },
    });
    head.el.classList.add('k-batch-groups__head');
    headers.push({ cat, box: head });
    const items = h('div', { class: 'k-batch-groups__items' });
    for (const g of cat.groups) {
      const box = createCheckbox({
        label: GROUP_LABELS[g],
        checked: selected.has(g),
        onChange: (checked) => {
          if (checked) selected.add(g);
          else selected.delete(g);
          changed();
        },
      });
      box.el.dataset.group = g;
      if (modified.has(g)) box.el.append(h('span', { class: 'k-batch-groups__dot', attrs: { title: 'Changed on the source photo', 'aria-label': 'changed' } }));
      boxes.set(g, box);
      items.append(box.el);
    }
    grid.append(h('fieldset', { class: 'k-batch-groups__cat' }, h('legend', { class: 'k-sr-only' }, cat.title), head.el, items));
  }
  sync();

  const el = h('div', { class: 'k-batch-checklist' }, opts.quickPresets !== false ? chipRow : null, grid);
  return {
    el,
    get: list,
    set(groups) {
      selected.clear();
      for (const g of groups) selected.add(g);
      sync();
    },
    onChange(cb) {
      listener = cb;
    },
    destroy() {
      d.dispose();
      for (const b of boxes.values()) b.destroy();
      for (const x of headers) x.box.destroy();
      el.remove();
    },
  };
}
