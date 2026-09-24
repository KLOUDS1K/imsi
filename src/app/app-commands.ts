/**
 * App-level commands (history, navigation between photos, modules, import /
 * export, save). Registered before the feature modules' own commands, so a
 * module can specialise a key by registering the same key later.
 */
import type { AppRuntime } from './createContext';

export function registerAppCommands(rt: AppRuntime): () => void {
  const { ctx, docs } = rt;
  const inDevelop = (): boolean => ctx.module.value === 'develop' && !!ctx.doc.value;
  const noGesture = (): boolean => !ctx.doc.value?.store.gestureActive;
  const offs = [
    ctx.commands.register({
      id: 'history.undo',
      label: 'Undo',
      keys: ['Mod+Z'],
      group: 'Edit',
      when: () => inDevelop() && noGesture(),
      run: () => {
        if (!ctx.doc.value?.store.undo()) ctx.toast('Nothing to undo', 'info', 1400);
      },
    }),
    ctx.commands.register({
      id: 'history.redo',
      label: 'Redo',
      keys: ['Shift+Mod+Z', 'Mod+Y'],
      group: 'Edit',
      when: () => inDevelop() && noGesture(),
      run: () => {
        if (!ctx.doc.value?.store.redo()) ctx.toast('Nothing to redo', 'info', 1400);
      },
    }),
    ctx.commands.register({
      id: 'doc.save',
      label: 'Save edits now',
      keys: ['Mod+S'],
      group: 'Edit',
      when: () => !!ctx.doc.value,
      run: () => {
        ctx.saveCurrent().then(
          () => ctx.toast('Edits saved', 'success', 1600),
          (err: unknown) => ctx.toast(`Saving failed: ${err instanceof Error ? err.message : String(err)}`, 'error'),
        );
      },
    }),
    ctx.commands.register({
      id: 'photo.next',
      label: 'Next photo',
      keys: ['ArrowRight'],
      group: 'Navigate',
      when: () => ctx.module.value === 'develop',
      run: () => void docs.step(1),
    }),
    ctx.commands.register({
      id: 'photo.prev',
      label: 'Previous photo',
      keys: ['ArrowLeft'],
      group: 'Navigate',
      when: () => ctx.module.value === 'develop',
      run: () => void docs.step(-1),
    }),
    ctx.commands.register({
      id: 'module.develop',
      label: 'Open in Develop',
      keys: ['D'],
      group: 'Navigate',
      when: () => ctx.module.value === 'library',
      run: () => void rt.enterDevelop(),
    }),
    ctx.commands.register({
      id: 'module.library',
      label: 'Back to Library',
      keys: ['G', 'Mod+Alt+1'],
      group: 'Navigate',
      when: () => ctx.module.value === 'develop',
      run: () => ctx.module.set('library'),
    }),
    ctx.commands.register({
      id: 'file.import',
      label: 'Import photos…',
      keys: ['Shift+Mod+I'],
      group: 'File',
      run: () => void ctx.importFiles(),
    }),
    ctx.commands.register({
      id: 'file.export',
      label: 'Export…',
      keys: ['Shift+Mod+E'],
      group: 'File',
      run: () => ctx.openExportDialog(),
    }),
  ];
  return () => offs.forEach((off) => off());
}
