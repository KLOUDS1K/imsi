/**
 * Copy Settings, Sync Settings and Apply Preset dialogs.
 */
import type { AppContext } from '@/app/context';
import { BatchError, batchApplyPreset, copySettings, pasteSettings as pasteClip, syncSettings } from '@/editor/library';
import { applyPreset, BUILTIN_PRESETS } from '@/editor/presets';
import { modifiedGroups } from '@/editor/state';
import type { Preset, SettingsGroup } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { createSearchInput, createSlider, openDialog } from '@/ui/kit';
import { isRawRecord, loadPhotoParams, splitOpenDoc } from './edits';
import { createGroupChecklist, defaultSyncGroups } from './groups';
import { startBatchProgress } from './progress';
import { queueThumbnailRefresh } from './thumbs';
import './batch.css';

const plural = (n: number, w = 'photo'): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Toast for a finished batch, including partial failures reported by the library. */
export function reportBatchError(ctx: AppContext, err: unknown, what: string): void {
  if (err instanceof BatchError) {
    ctx.toast(`${what}: ${plural(err.failures.length)} could not be updated (${err.succeeded} done).`, 'error', 6000);
  } else if (!(err instanceof DOMException && err.name === 'AbortError')) {
    console.error(err);
    ctx.toast(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
  }
}

/** The photo whose settings "Copy" uses: explicit id, else the open photo, else the most-selected one. */
function resolveSourceId(ctx: AppContext, sourceId?: string): string | null {
  return sourceId ?? ctx.doc.value?.photoId ?? ctx.selection.value[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Copy Settings                                                       */
/* ------------------------------------------------------------------ */

export async function openCopySettingsDialog(ctx: AppContext, sourceId?: string): Promise<boolean> {
  const id = resolveSourceId(ctx, sourceId);
  const rec = id ? ctx.library.get(id) : undefined;
  if (!id || !rec) {
    ctx.toast('Select a photo to copy its settings.', 'info');
    return false;
  }
  const params = await loadPhotoParams(ctx, id);
  const modified = modifiedGroups(params, isRawRecord(rec));
  const checklist = createGroupChecklist({ value: modified.length ? modified : defaultSyncGroups([]), modified });
  const dlg = openDialog<'copy' | 'cancel'>({
    title: 'Copy Settings',
    description: `From ${rec.name}. Choose which settings go to the clipboard; paste them onto other photos with ⇧⌘V.`,
    content: checklist.el,
    size: 'lg',
    class: 'k-batch-dialog',
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: 'Copy', value: 'copy', variant: 'primary', autofocus: true },
    ],
  });
  const res = await dlg.result;
  const groups = checklist.get();
  checklist.destroy();
  if (res !== 'copy') return false;
  if (groups.length === 0) {
    ctx.toast('Nothing copied — no settings were selected.', 'info');
    return false;
  }
  ctx.settingsClipboard.set(copySettings(params, groups));
  ctx.toast(`Copied ${plural(groups.length, 'setting group')} from ${rec.name}.`, 'success');
  return true;
}

/* ------------------------------------------------------------------ */
/* Sync Settings                                                       */
/* ------------------------------------------------------------------ */

/** Apply `groups` of `sourceId` to the targets (the open photo is updated live). */
export async function runSync(ctx: AppContext, sourceId: string, targetIds: readonly string[], groups: SettingsGroup[]): Promise<void> {
  const targets = targetIds.filter((t) => t !== sourceId && ctx.library.get(t));
  if (targets.length === 0 || groups.length === 0) return;
  const source = await loadPhotoParams(ctx, sourceId);
  const { docId, others } = splitOpenDoc(ctx, targets);
  const doc = ctx.doc.value;
  if (docId && doc) {
    const next = pasteClip(doc.store.params, copySettings(source, groups), { meta: doc.meta });
    if (next !== doc.store.params) {
      doc.store.replace(next, 'Sync Settings');
      ctx.requestRender();
    }
  }
  if (others.length === 0) {
    if (docId) queueThumbnailRefresh(ctx, [docId]);
    return;
  }
  const prog = startBatchProgress(ctx, 'Syncing settings');
  const done: string[] = [];
  try {
    await syncSettings(ctx.library, source, others, groups, (n, total) => prog.update(n, total), {
      signal: prog.signal,
      onApplied: (id) => done.push(id),
    });
    ctx.toast(`Synced ${plural(groups.length, 'setting group')} to ${plural(targets.length)}.`, 'success');
  } catch (err) {
    reportBatchError(ctx, err, 'Sync');
  } finally {
    prog.finish();
    queueThumbnailRefresh(ctx, docId ? [docId, ...done] : done);
  }
}

export async function openSyncDialog(ctx: AppContext, sourceId: string, targetIds: string[]): Promise<boolean> {
  const rec = ctx.library.get(sourceId);
  const targets = targetIds.filter((t) => t !== sourceId && ctx.library.get(t));
  if (!rec) {
    ctx.toast('The source photo is no longer in the library.', 'error');
    return false;
  }
  if (targets.length === 0) {
    ctx.toast('Select the photos to sync to (Cmd/Ctrl- or Shift-click), then sync again.', 'info');
    return false;
  }
  const params = await loadPhotoParams(ctx, sourceId);
  const modified = modifiedGroups(params, isRawRecord(rec));
  const checklist = createGroupChecklist({ value: defaultSyncGroups(modified), modified });
  const note = h('p', { class: 'k-batch-note' }, 'AI masks are recomputed for each photo; generative removals stay with the photo they were made on.');
  const dlg = openDialog<'sync' | 'cancel'>({
    title: 'Sync Settings',
    description: `From ${rec.name} to ${plural(targets.length)}. The dot marks settings changed on the source.`,
    content: h('div', {}, checklist.el, note),
    size: 'lg',
    class: 'k-batch-dialog',
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: 'Synchronize', value: 'sync', variant: 'primary', autofocus: true },
    ],
  });
  const res = await dlg.result;
  const groups = checklist.get();
  checklist.destroy();
  if (res !== 'sync' || groups.length === 0) return false;
  await runSync(ctx, sourceId, targets, groups);
  return true;
}

/* ------------------------------------------------------------------ */
/* Apply preset to many                                                */
/* ------------------------------------------------------------------ */

export async function runBatchPreset(ctx: AppContext, ids: readonly string[], preset: Preset, amount: number): Promise<void> {
  const { docId, others } = splitOpenDoc(ctx, ids.filter((id) => ctx.library.get(id)));
  const doc = ctx.doc.value;
  const pct = Math.round(amount);
  if (docId && doc) {
    doc.store.replace(applyPreset(doc.store.params, preset, amount), pct === 100 ? `Preset: ${preset.name}` : `Preset: ${preset.name} (${pct}%)`);
    ctx.requestRender();
  }
  const done: string[] = [];
  if (others.length > 0) {
    const prog = startBatchProgress(ctx, `Applying ${preset.name}`);
    try {
      await batchApplyPreset(ctx.library, preset, others, amount, (n, total) => prog.update(n, total), {
        signal: prog.signal,
        onApplied: (id) => done.push(id),
      });
    } catch (err) {
      reportBatchError(ctx, err, 'Preset');
    } finally {
      prog.finish();
    }
  }
  queueThumbnailRefresh(ctx, docId ? [docId, ...done] : done);
  ctx.toast(`Applied ${preset.name} to ${plural((docId ? 1 : 0) + done.length)}.`, 'success');
}

export async function openBatchPresetDialog(ctx: AppContext, ids: string[]): Promise<boolean> {
  const targets = ids.filter((id) => ctx.library.get(id));
  if (targets.length === 0) {
    ctx.toast('Select photos to apply a preset to.', 'info');
    return false;
  }
  const d = new Disposer();
  const presets = ctx.presets.value.length > 0 ? ctx.presets.value : BUILTIN_PRESETS;
  let chosen: Preset | null = null;
  let amount = 100;
  const list = h('div', { class: 'k-batch-presets', attrs: { role: 'listbox', 'aria-label': 'Presets' } });
  const buttons: { preset: Preset; el: HTMLButtonElement }[] = [];
  const render = (filter: string): void => {
    list.replaceChildren();
    const f = filter.trim().toLowerCase();
    const groups = new Map<string, Preset[]>();
    for (const p of presets) {
      if (f && !`${p.name} ${p.group}`.toLowerCase().includes(f)) continue;
      const arr = groups.get(p.group) ?? [];
      arr.push(p);
      groups.set(p.group, arr);
    }
    buttons.length = 0;
    for (const [group, items] of groups) {
      list.append(h('div', { class: 'k-label k-batch-presets__group' }, group));
      for (const p of items) {
        const b = h(
          'button',
          { type: 'button', class: 'k-batch-presets__item', attrs: { role: 'option', 'aria-selected': String(chosen?.id === p.id) }, dataset: { id: p.id } },
          p.name,
        );
        buttons.push({ preset: p, el: b });
        list.append(b);
      }
    }
    if (buttons.length === 0) list.append(h('p', { class: 'k-batch-note' }, 'No preset matches.'));
  };
  d.add(
    on(list, 'click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.k-batch-presets__item');
      const hit = b && buttons.find((x) => x.el === b);
      if (!hit) return;
      chosen = hit.preset;
      for (const x of buttons) x.el.setAttribute('aria-selected', String(x === hit));
    }),
  );
  d.add(
    on(list, 'dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.k-batch-presets__item') && chosen) dlg.close('apply');
    }),
  );
  const search = createSearchInput({ placeholder: 'Search presets', width: '100%', debounce: 60, onInput: render });
  const slider = createSlider({ label: 'Amount', min: 0, max: 200, value: 100, defaultValue: 100, step: 1, unit: '%', fill: 'min', onInput: (v) => (amount = v) });
  render('');
  const dlg = openDialog<'apply' | 'cancel'>({
    title: 'Apply Preset',
    description: `Applies to ${plural(targets.length)}. Only the settings the preset contains change.`,
    content: h('div', { class: 'k-batch-preset-dialog' }, search.el, list, slider.el),
    size: 'md',
    class: 'k-batch-dialog',
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      {
        label: 'Apply',
        value: 'apply',
        variant: 'primary',
        onClick: () => {
          if (chosen) return true;
          ctx.toast('Choose a preset first.', 'info');
          return false;
        },
      },
    ],
  });
  const res = await dlg.result;
  d.dispose();
  search.destroy();
  slider.destroy();
  const preset = chosen as Preset | null;
  if (res !== 'apply' || !preset) return false;
  await runBatchPreset(ctx, targets, preset, amount);
  return true;
}
