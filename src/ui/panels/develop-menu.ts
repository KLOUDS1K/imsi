/**
 * Develop "…" menu: reset, copy / paste settings, and edit data save / load
 * (.kloud.json sidecar with history + snapshots, or a Lightroom-compatible XMP).
 */
import type { AppContext } from '../../app/context';
import { applyPartial, EDIT_FILE_EXTENSION, normalizeParams, paramsToXmp, parseEditFile, serializeEditFile, xmpToParams } from '../../editor/state';
import { openCopySettingsDialog, pasteSettings } from '../batch';
import { openMenu, type AnchorLike, type MenuItem } from '../kit';
import { pickFiles, saveBlob } from './util';

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

async function loadEditFile(ctx: AppContext): Promise<void> {
  const doc = ctx.doc.value;
  if (!doc) return;
  const [file] = await pickFiles(`${EDIT_FILE_EXTENSION},.json,.xmp,application/json,application/rdf+xml`, false);
  if (!file) return;
  const text = await file.text();
  try {
    if (/\.xmp$/i.test(file.name) || /<x:xmpmeta|crs:/.test(text)) {
      const res = xmpToParams(text);
      if (res.groups.length === 0) throw new Error('no Lightroom develop settings found');
      doc.store.replace(applyPartial(doc.store.params, res.params, res.groups), `Load XMP: ${file.name}`);
      ctx.toast(`Applied ${res.groups.length} setting groups from ${file.name}.`, 'success');
    } else {
      const state = parseEditFile(text);
      doc.store.replace(normalizeParams(state.params, doc.isRaw), `Load edit: ${file.name}`);
      ctx.toast(`Loaded edit from ${file.name}.`, 'success');
    }
  } catch (e) {
    ctx.toast(`Couldn't read ${file.name}: ${(e as Error).message}`, 'error');
  }
}

export function openDevelopMenu(ctx: AppContext, anchor: AnchorLike): void {
  const doc = ctx.doc.value;
  if (!doc) return;
  const base = stem(doc.record.name);
  const items: MenuItem[] = [
    { label: 'Reset all settings', icon: 'reset', shortcut: 'Shift+Mod+R', onSelect: () => doc.store.reset('Reset All') },
    { kind: 'separator' },
    { label: 'Copy settings…', icon: 'copy', shortcut: 'Shift+Mod+C', onSelect: () => void openCopySettingsDialog(ctx, doc.photoId) },
    {
      label: 'Paste settings',
      icon: 'clipboard',
      shortcut: 'Shift+Mod+V',
      disabled: !ctx.settingsClipboard.value,
      onSelect: () => void pasteSettings(ctx, [doc.photoId]),
    },
    { kind: 'separator' },
    {
      label: 'Save edit file',
      icon: 'save',
      hint: EDIT_FILE_EXTENSION,
      onSelect: () => saveBlob(serializeEditFile(doc.store.serialize()), `${base}${EDIT_FILE_EXTENSION}`),
    },
    {
      label: 'Export XMP sidecar',
      icon: 'download',
      hint: 'Lightroom',
      onSelect: () => saveBlob(new Blob([paramsToXmp(doc.store.params, doc.meta)], { type: 'application/rdf+xml' }), `${base}.xmp`),
    },
    { label: 'Load edit or XMP…', icon: 'upload', onSelect: () => void loadEditFile(ctx) },
    { kind: 'separator' },
    {
      label: 'New snapshot…',
      icon: 'bookmark',
      shortcut: 'Shift+Mod+N',
      onSelect: async () => {
        const name = await ctx.prompt({ title: 'New snapshot', value: `Snapshot ${doc.store.snapshots.length + 1}`, confirmLabel: 'Save' });
        if (name) doc.store.createSnapshot(name.trim());
      },
    },
  ];
  openMenu(anchor, items, { ariaLabel: 'Develop actions', minWidth: 230 });
}
