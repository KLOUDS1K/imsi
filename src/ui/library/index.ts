/**
 * Library module UI: sidebar collections, the Archive-style grid/list view,
 * the Develop filmstrip, keyboard shortcuts and demo photos.
 */
import type { AppContext } from '../../app/context';
import type { ColorLabel } from '../../editor/types';
import { applyPreviousEdit, openCopySettingsDialog, pasteSettings } from '../batch';
import { Disposer } from '../dom';
import { LABEL_KEYS, openInDevelop, removePhotos, setFlag, setRating, syncFromSelection, targetIds, toggleFavorite, toggleLabel } from './actions';
import { navigateKey, selectAll } from './selection';

export { createLibrarySidebar } from './sidebar';
export { createLibraryView } from './view';
export { createFilmstrip } from './filmstrip';
export { createSamplePhotos } from './samples';
export { librarySignals, setLibrarySearch, setLibraryCollection } from './state';

export function registerLibraryCommands(ctx: AppContext): () => void {
  const d = new Disposer();
  const lib = () => ctx.module.value === 'library';
  const any = () => targetIds(ctx).length > 0;
  const reg = (id: string, label: string, keys: string[], run: (e?: KeyboardEvent) => void, when: () => boolean = any, group = 'Library') =>
    d.add(ctx.commands.register({ id, label, keys, group, when, run }));

  for (let r = 0; r <= 5; r++) reg(`lib.rate${r}`, r ? `Rate ${r} star${r > 1 ? 's' : ''}` : 'Clear rating', [String(r)], () => void setRating(ctx, targetIds(ctx), r));
  reg('lib.pick', 'Flag as pick', ['P'], () => void setFlag(ctx, targetIds(ctx), 'pick'), () => lib() && any());
  reg('lib.reject', 'Flag as reject', ['X'], () => void setFlag(ctx, targetIds(ctx), 'reject'), () => lib() && any());
  reg('lib.unflag', 'Remove flag', ['U'], () => void setFlag(ctx, targetIds(ctx), 'none'), () => lib() && any());
  for (const [label, key] of Object.entries(LABEL_KEYS) as [ColorLabel, string][]) {
    reg(`lib.label.${label}`, `Label ${label}`, [key], () => void toggleLabel(ctx, targetIds(ctx), label));
  }
  reg('lib.favorite', 'Toggle favorite', ['H'], () => void toggleFavorite(ctx, targetIds(ctx)));
  reg('lib.remove', 'Remove from library', ['Delete', 'Backspace'], () => void removePhotos(ctx, targetIds(ctx)), () => lib() && any());
  reg('lib.selectAll', 'Select all', ['Mod+A'], () => selectAll(ctx), lib);
  reg('lib.open', 'Open in Develop', ['Enter', 'D'], () => {
    const id = targetIds(ctx)[0];
    if (id) void openInDevelop(ctx, id);
  }, () => lib() && any());
  reg('lib.grid', 'Library grid', ['G'], () => ctx.module.set('library'), () => true, 'Navigate');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    d.add(
      ctx.commands.register({
        id: `lib.nav.${key}`,
        label: 'Move selection',
        keys: [key, `Shift+${key}`],
        group: 'Library',
        when: lib,
        run: (e) => {
          if (e) navigateKey(ctx, e);
        },
      }),
    );
  }
  reg('lib.copySettings', 'Copy settings', ['Shift+Mod+C'], () => void openCopySettingsDialog(ctx, targetIds(ctx)[0]), any, 'Develop');
  reg('lib.pasteSettings', 'Paste settings', ['Shift+Mod+V'], () => void pasteSettings(ctx, targetIds(ctx)), () => any() && !!ctx.settingsClipboard.value, 'Develop');
  reg('lib.sync', 'Sync settings', ['Shift+Mod+S'], () => syncFromSelection(ctx), any, 'Develop');
  reg('lib.previous', 'Paste from previous', ['Alt+Mod+V'], () => void applyPreviousEdit(ctx, targetIds(ctx)), any, 'Develop');
  return () => d.dispose();
}
