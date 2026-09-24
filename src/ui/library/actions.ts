/**
 * Photo actions shared by the grid, list, filmstrip, keyboard commands and
 * context menus.
 */
import type { AppContext } from '@/app/context';
import type { ColorLabel, PickFlag } from '@/editor/types';
import {
  applyPreviousEdit,
  openBatchPresetDialog,
  openCopySettingsDialog,
  openSyncDialog,
  pasteSettings,
  runAiAutoBatch,
} from '@/ui/batch';
import type { MenuItem } from '@/ui/kit';
import { countLabel } from './format';
import { setLibraryCollection } from './state';

export const LABEL_NAMES: Record<ColorLabel, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
export const LABEL_KEYS: Partial<Record<ColorLabel, string>> = { red: '6', yellow: '7', green: '8', blue: '9' };

/**
 * Photos a shortcut acts on. Library: the selection. Develop: the open photo,
 * or the filmstrip selection when it has several photos including the open one.
 */
export function targetIds(ctx: AppContext): string[] {
  const sel = ctx.selection.value;
  if (ctx.module.value === 'develop') {
    const docId = ctx.doc.value?.photoId;
    if (!docId) return sel.slice();
    return sel.length > 1 && sel.includes(docId) ? sel.slice() : [docId];
  }
  return sel.slice();
}

function fail(ctx: AppContext, what: string, err: unknown): void {
  console.error(err);
  ctx.toast(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
}

export async function setRating(ctx: AppContext, ids: string[], rating: number): Promise<void> {
  if (!ids.length) return;
  try {
    await ctx.library.setRating(ids, rating);
  } catch (e) {
    fail(ctx, 'Rating', e);
  }
}

export async function setFlag(ctx: AppContext, ids: string[], flag: PickFlag): Promise<void> {
  if (!ids.length) return;
  try {
    await ctx.library.setFlag(ids, flag);
  } catch (e) {
    fail(ctx, 'Flag', e);
  }
}

/** Setting the label every target already has clears it (Lightroom toggle). */
export async function toggleLabel(ctx: AppContext, ids: string[], label: ColorLabel): Promise<void> {
  if (!ids.length) return;
  const all = ids.every((id) => ctx.library.get(id)?.label === label);
  try {
    await ctx.library.setLabel(ids, all ? null : label);
  } catch (e) {
    fail(ctx, 'Label', e);
  }
}

export async function toggleFavorite(ctx: AppContext, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await ctx.library.toggleFavorite(ids);
  } catch (e) {
    fail(ctx, 'Favorite', e);
  }
}

/** Open in Develop (Enter / D / double-click). */
export async function openInDevelop(ctx: AppContext, id: string): Promise<void> {
  try {
    if (!ctx.selection.value.includes(id)) ctx.selection.set([id]);
    await ctx.openPhoto(id);
    ctx.module.set('develop');
  } catch (e) {
    fail(ctx, 'Opening the photo', e);
  }
}

export async function removePhotos(ctx: AppContext, ids: string[]): Promise<boolean> {
  const list = ids.filter((id) => ctx.library.get(id));
  if (list.length === 0) return false;
  const one = list.length === 1 ? ctx.library.get(list[0])?.name : null;
  const ok = await ctx.confirm({
    title: one ? `Remove “${one}” from the library?` : `Remove ${countLabel(list.length)} from the library?`,
    message: 'Their edits in KLOUD Studio are deleted too. The original files on your device are not affected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return false;
  try {
    if (ctx.doc.value && list.includes(ctx.doc.value.photoId)) ctx.closePhoto();
    await ctx.library.remove(list);
    ctx.toast(`Removed ${countLabel(list.length)}.`, 'success');
    return true;
  } catch (e) {
    fail(ctx, 'Removing', e);
    return false;
  }
}

export async function addToAlbum(ctx: AppContext, ids: string[], albumId: string): Promise<void> {
  try {
    await ctx.library.addToAlbum(ids, albumId);
    const name = ctx.library.albums().find((a) => a.id === albumId)?.name ?? 'album';
    ctx.toast(`Added ${countLabel(ids.length)} to ${name}.`, 'success');
  } catch (e) {
    fail(ctx, 'Adding to album', e);
  }
}

export async function createAlbumWith(ctx: AppContext, ids: string[]): Promise<void> {
  const name = await ctx.prompt({ title: 'New album', label: 'Album name', placeholder: 'e.g. Seoul Night', confirmLabel: 'Create' });
  if (!name?.trim()) return;
  try {
    const album = await ctx.library.createAlbum(name.trim());
    if (ids.length) await ctx.library.addToAlbum(ids, album.id);
    ctx.toast(ids.length ? `Created ${album.name} with ${countLabel(ids.length)}.` : `Created ${album.name}.`, 'success');
  } catch (e) {
    fail(ctx, 'Creating the album', e);
  }
}

export function setReference(ctx: AppContext, id: string): void {
  ctx.referenceId.set(id);
  const name = ctx.library.get(id)?.name ?? 'photo';
  ctx.toast(`${name} is the reference photo. Choose “Reference” in the compare menu to see it side by side.`, 'info');
}

export function revealFolder(ctx: AppContext, id: string): void {
  const rec = ctx.library.get(id);
  if (!rec) return;
  setLibraryCollection(rec.folder ? { kind: 'folder', path: rec.folder } : { kind: 'all' });
  ctx.module.set('library');
  ctx.selection.set([id]);
}

/** Sync from the most-selected photo (or the open one) to the other selected photos. */
export function syncFromSelection(ctx: AppContext, ids: string[] = targetIds(ctx)): void {
  const source = ctx.module.value === 'develop' && ctx.doc.value ? ctx.doc.value.photoId : ids[0];
  if (!source) return;
  const sel = ctx.module.value === 'develop' ? ctx.selection.value : ids;
  void openSyncDialog(ctx, source, sel.filter((x) => x !== source));
}

/**
 * Context menu for `ids` (the clicked photo first). Used by the grid, the list
 * and the filmstrip.
 */
export function photoMenu(ctx: AppContext, ids: string[]): MenuItem[] {
  const first = ctx.library.get(ids[0]);
  if (!first) return [];
  const many = ids.length > 1;
  const count = many ? ` (${ids.length})` : '';
  const albums = ctx.library.albums();
  const clip = ctx.settingsClipboard.value;
  return [
    { label: 'Open in Develop', icon: 'develop', shortcut: 'D', onSelect: () => void openInDevelop(ctx, first.id) },
    { kind: 'separator' },
    {
      label: 'Rating',
      icon: 'star',
      submenu: [0, 1, 2, 3, 4, 5].map((n) => ({
        label: n === 0 ? 'No rating' : '★'.repeat(n),
        shortcut: String(n),
        checked: !many && first.rating === n,
        onSelect: () => void setRating(ctx, ids, n),
      })),
    },
    {
      label: 'Flag',
      icon: 'flag',
      submenu: [
        { label: 'Pick', shortcut: 'P', checked: !many && first.flag === 'pick', onSelect: () => void setFlag(ctx, ids, 'pick') },
        { label: 'Unflagged', shortcut: 'U', checked: !many && first.flag === 'none', onSelect: () => void setFlag(ctx, ids, 'none') },
        { label: 'Reject', shortcut: 'X', checked: !many && first.flag === 'reject', onSelect: () => void setFlag(ctx, ids, 'reject') },
      ],
    },
    {
      label: 'Color label',
      icon: 'tag',
      submenu: [
        ...(['red', 'yellow', 'green', 'blue', 'purple'] as ColorLabel[]).map((l) => ({
          label: LABEL_NAMES[l],
          shortcut: LABEL_KEYS[l],
          checked: !many && first.label === l,
          onSelect: () => void toggleLabel(ctx, ids, l),
        })),
        { kind: 'separator' as const },
        { label: 'None', checked: !many && first.label === null, onSelect: () => void ctx.library.setLabel(ids, null) },
      ],
    },
    {
      label: first.favorite && !many ? 'Remove from Favorites' : 'Add to Favorites',
      icon: first.favorite && !many ? 'heart-filled' : 'heart',
      shortcut: 'H',
      onSelect: () => void toggleFavorite(ctx, ids),
    },
    {
      label: 'Add to album',
      icon: 'bookmark',
      submenu: [
        ...albums.map((a) => ({ label: a.name, checked: !many && first.albumIds.includes(a.id), onSelect: () => void addToAlbum(ctx, ids, a.id) })),
        ...(albums.length ? [{ kind: 'separator' as const }] : []),
        { label: 'New album…', icon: 'plus' as const, onSelect: () => void createAlbumWith(ctx, ids) },
      ],
    },
    { kind: 'separator' },
    { label: 'Copy settings…', icon: 'copy', shortcut: 'Shift+Mod+C', onSelect: () => void openCopySettingsDialog(ctx, first.id) },
    { label: `Paste settings${count}`, icon: 'clipboard', shortcut: 'Shift+Mod+V', disabled: !clip, onSelect: () => void pasteSettings(ctx, ids) },
    { label: 'Sync settings…', icon: 'refresh', shortcut: 'Shift+Mod+S', disabled: !many, onSelect: () => void openSyncDialog(ctx, ids[0], ids.slice(1)) },
    { label: `Previous settings${count}`, icon: 'history', shortcut: 'Alt+Mod+V', onSelect: () => void applyPreviousEdit(ctx, ids) },
    { label: `Apply preset${count}…`, icon: 'sliders', onSelect: () => void openBatchPresetDialog(ctx, ids) },
    { label: `AI auto edit${count}`, icon: 'sparkles', hint: 'Heuristic', onSelect: () => void runAiAutoBatch(ctx, ids) },
    { kind: 'separator' },
    { label: `Export${count}…`, icon: 'export', shortcut: 'Shift+Mod+E', onSelect: () => ctx.openExportDialog(ids) },
    { label: 'Set as reference photo', icon: 'compare', disabled: many, onSelect: () => setReference(ctx, first.id) },
    { label: 'Show in folder', icon: 'folder', disabled: !first.folder, hint: first.folder || undefined, onSelect: () => revealFolder(ctx, first.id) },
    { kind: 'separator' },
    { label: `Remove from library${count}`, icon: 'trash', danger: true, shortcut: 'Delete', onSelect: () => void removePhotos(ctx, ids) },
  ];
}

/** Ids a context-click on `id` acts on: the whole selection when `id` is part of it, else just `id` (which becomes selected). */
export function menuTargets(ctx: AppContext, id: string): string[] {
  const sel = ctx.selection.value;
  if (sel.includes(id)) return [id, ...sel.filter((x) => x !== id)];
  ctx.selection.set([id]);
  return [id];
}
