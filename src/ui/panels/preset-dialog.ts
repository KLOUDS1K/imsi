/**
 * "New preset" dialog: name, folder, which setting groups to include (partial
 * presets) and optional camera / lens / ISO conditions with auto-apply.
 */
import type { AppContext } from '../../app/context';
import { createPreset } from '../../editor/presets';
import { modifiedGroups } from '../../editor/state';
import type { Preset, PresetConditions } from '../../editor/types';
import { createGroupChecklist } from '../batch';
import { h } from '../dom';
import { createToggle, openDialog } from '../kit';

function input(value: string, placeholder = '', type = 'text'): HTMLInputElement {
  return h('input', { class: 'k-pnl-form__input', type, value, placeholder });
}

function row(label: string, ...els: (Node | string)[]): HTMLElement {
  return h('label', { class: 'k-pnl-form__field' }, h('span', { class: 'k-pnl-form__label' }, label), h('span', { class: 'k-pnl-form__ctl' }, ...els));
}

export async function openCreatePresetDialog(ctx: AppContext): Promise<Preset | null> {
  const doc = ctx.doc.value;
  if (!doc) {
    ctx.toast('Open a photo first.', 'info');
    return null;
  }
  const params = doc.store.params;
  const modified = modifiedGroups(params, doc.isRaw);
  if (modified.length === 0) {
    ctx.toast('Nothing to save: every setting is at its default.', 'info');
    return null;
  }
  const name = input('', 'My look');
  const folder = input('User Presets');
  // Geometry and retouching are photo-specific: leave them out unless the user opts in.
  const checklist = createGroupChecklist({ value: modified.filter((g) => g !== 'crop' && g !== 'retouch' && g !== 'masks'), modified, quickPresets: false });
  const camera = input('', doc.meta.camera ?? doc.meta.model ?? 'e.g. α7 IV');
  const lens = input('', doc.meta.lens ?? 'e.g. 24-70');
  const isoMin = input('', 'min', 'number');
  const isoMax = input('', 'max', 'number');
  const auto = createToggle({ label: 'Apply automatically to matching photos on open', size: 'sm' });
  const content = h(
    'div',
    { class: 'k-batch-dialog' },
    row('Name', name),
    row('Folder', folder),
    h('div', { class: 'k-label' }, 'Include'),
    checklist.el,
    h('div', { class: 'k-label' }, 'Conditions (optional)'),
    h('p', { class: 'k-batch-note' }, 'Camera, lens or ISO specific presets. Text matches part of the name; /regex/ is allowed.'),
    row('Camera', camera),
    row('Lens', lens),
    row('ISO', isoMin, '–', isoMax),
    auto.el,
  );
  const dialog = openDialog<'save' | 'cancel'>({
    title: 'New preset',
    content,
    size: 'md',
    initialFocus: name,
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: 'Create preset', value: 'save', variant: 'primary', icon: 'plus' },
    ],
  });
  const result = await dialog.result;
  checklist.destroy();
  auto.destroy();
  if (result !== 'save') return null;
  const groups = checklist.get();
  if (groups.length === 0) {
    ctx.toast('Choose at least one setting group.', 'info');
    return null;
  }
  const conditions: PresetConditions = {};
  if (camera.value.trim()) conditions.camera = camera.value.trim();
  if (lens.value.trim()) conditions.lens = lens.value.trim();
  if (isoMin.value) conditions.isoMin = Number(isoMin.value);
  if (isoMax.value) conditions.isoMax = Number(isoMax.value);
  if (auto.isChecked()) conditions.autoApply = true;
  const preset = createPreset(name.value.trim() || 'Untitled Preset', params, groups, {
    group: folder.value.trim() || 'User Presets',
    conditions: Object.keys(conditions).length ? conditions : undefined,
  });
  await ctx.savePreset(preset);
  ctx.toast(`Saved preset “${preset.name}” (${groups.length} groups).`, 'success');
  return preset;
}
