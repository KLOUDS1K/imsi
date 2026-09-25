/**
 * The 44px app toolbar, laid out like the kloud.photography archive bar:
 *
 *   [≡] ‹ › ↑  Library › Folder › photo   [Library | Develop]   ……   (Search by name) [▦|☰] ⇅  ☾ 🔒 ?  [Export]
 *
 * Library shows the search pill, grid/list toggle and sort menu; Develop swaps
 * them for undo/redo, before/after and panel toggles. On phones everything
 * collapses to icons (see toolbar.css).
 */
import './toolbar.css';
import type { LibrarySort } from '@/editor/types';
import {
  attachMenu,
  createBreadcrumb,
  createButton,
  createIconButton,
  createNavArrows,
  createSearchInput,
  createSegmentedControl,
  createThemeToggle,
  createToolbar,
  toolbarDivider,
  toolbarGroup,
  toolbarSpacer,
  type Crumb,
  type MenuItem,
} from '@/ui/kit';
import { Disposer } from '@/ui/dom';
import type { AppModule } from '@/app/context';
import type { AppRuntime } from '@/app/createContext';
import { SORT_LABELS, type ShellState } from './state';

export interface ToolbarActions {
  exit?: { label?: string; onExit(): void };
  publish?: { label?: string; onPublish(): void | Promise<void> };
  openDrawer(): void;
  openHelp(): void;
  /** Navigate the Library one folder level up. Returns false at the root. */
  libraryUp(): boolean;
  canGoUp(): boolean;
  /** Jump to a Library breadcrumb level (index into state.libraryPath). */
  libraryCrumb(index: number): void;
}

export interface AppToolbar {
  el: HTMLElement;
  dispose(): void;
}

const SORTS: LibrarySort[] = ['date-taken', 'date-added', 'edited', 'name', 'rating', 'camera', 'iso', 'focal-length', 'size'];

export function createAppToolbar(rt: AppRuntime, state: ShellState, actions: ToolbarActions): AppToolbar {
  const { ctx } = rt;
  const d = new Disposer();

  /* ---- left: drawer, chevrons, breadcrumb, module switch ---- */
  const menuBtn = createIconButton({ icon: 'menu', label: 'Show sidebar', class: 'k-tb__drawer', onClick: () => actions.openDrawer() });
  const exitBtn = actions.exit
    ? createIconButton({ icon: 'arrow-left', label: actions.exit.label ?? 'Back', onClick: () => actions.exit?.onExit() })
    : null;
  const arrows = createNavArrows({
    onBack: () => {
      if (ctx.module.value === 'develop') ctx.module.set('library');
    },
    onForward: () => {
      if (ctx.module.value === 'library') void rt.enterDevelop(rt.lastOpenedId.value ?? undefined);
    },
    onUp: () => {
      if (ctx.module.value === 'develop') ctx.module.set('library');
      else actions.libraryUp();
    },
  });
  const crumbs = createBreadcrumb([{ label: 'Library' }]);
  const moduleSwitch = createSegmentedControl<AppModule>({
    options: [
      { value: 'library', label: 'Library', icon: 'library', title: 'Library (G)' },
      { value: 'develop', label: 'Develop', icon: 'develop', title: 'Develop (D)' },
    ],
    value: ctx.module.value,
    ariaLabel: 'Module',
    size: 'sm',
    onChange: (m) => {
      if (m === 'develop') void rt.enterDevelop();
      else ctx.module.set('library');
    },
  });
  moduleSwitch.el.classList.add('k-tb__modules');
  d.add(() => [exitBtn, menuBtn, arrows, crumbs, moduleSwitch].forEach((c) => c?.destroy()));

  /* ---- library controls ---- */
  const search = createSearchInput({
    placeholder: 'Search by name',
    ariaLabel: 'Search photos by name',
    width: '220px',
    value: state.librarySearch.value,
    onInput: (v) => state.librarySearch.set(v),
  });
  search.el.classList.add('k-tb__search');
  const viewToggle = createSegmentedControl<'grid' | 'list'>({
    options: [
      { value: 'grid', icon: 'grid', title: 'Grid view' },
      { value: 'list', icon: 'list', title: 'List view' },
    ],
    value: state.libraryView.value,
    ariaLabel: 'Library view',
    size: 'sm',
    onChange: (v) => state.libraryView.set(v),
  });
  viewToggle.el.classList.add('k-tb__viewtoggle');
  const sortBtn = createIconButton({ icon: 'arrow-up-down', label: 'Sort' });
  const sortItems = (): MenuItem[] => {
    const cur = state.librarySort.value;
    return [
      { kind: 'header', label: 'Sort by' },
      ...SORTS.map((s): MenuItem => ({ label: SORT_LABELS[s], checked: cur.sort === s, onSelect: () => state.librarySort.set({ ...state.librarySort.value, sort: s }) })),
      { kind: 'separator' },
      { label: 'Ascending', icon: 'arrow-up', checked: cur.order === 'asc', onSelect: () => state.librarySort.set({ ...state.librarySort.value, order: 'asc' }) },
      { label: 'Descending', icon: 'arrow-down', checked: cur.order === 'desc', onSelect: () => state.librarySort.set({ ...state.librarySort.value, order: 'desc' }) },
    ];
  };
  d.add(attachMenu(sortBtn.el, sortItems, { placement: 'bottom-end', ariaLabel: 'Sort photos' }));
  const importBtn = createIconButton({ icon: 'upload', label: 'Import photos', shortcut: 'Shift+Mod+I' });
  d.add(
    attachMenu(
      importBtn.el,
      () => [
        { label: 'Import photos…', icon: 'images', shortcut: 'Shift+Mod+I', onSelect: () => void ctx.importFiles() },
        { label: 'Import folder…', icon: 'folder-plus', onSelect: () => void rt.importFolder() },
        { kind: 'separator' },
        { label: 'Add sample photos', icon: 'sparkles', onSelect: () => void addSamples(rt) },
      ],
      { placement: 'bottom-end', ariaLabel: 'Import' },
    ),
  );
  d.add(state.librarySearch.subscribe((v) => v !== search.getValue() && search.setValue(v, true)));
  d.add(state.libraryView.subscribe((v) => viewToggle.setValue(v, true)));
  const libraryGroup = toolbarGroup(search.el, viewToggle.el, sortBtn.el, importBtn.el);
  libraryGroup.classList.add('k-tb__library');
  d.add(() => [search, viewToggle, sortBtn, importBtn].forEach((c) => c.destroy()));

  /* ---- develop controls ---- */
  const undo = createIconButton({ icon: 'undo', label: 'Undo', shortcut: 'Mod+Z', onClick: () => ctx.doc.value?.store.undo() });
  const redo = createIconButton({ icon: 'redo', label: 'Redo', shortcut: 'Shift+Mod+Z', onClick: () => ctx.doc.value?.store.redo() });
  const before = createIconButton({
    icon: 'compare',
    label: 'Before / after',
    shortcut: 'Y',
    pressed: false,
    autoToggle: false,
    class: 'k-tb__before',
    onClick: () => {
      const v = ctx.view.value;
      ctx.view.set({ ...v, compare: v.compare === 'off' ? 'split-vertical' : 'off' });
    },
  });
  const leftToggle = createIconButton({
    icon: 'sidebar',
    label: 'Left panel',
    pressed: state.leftOpen.value,
    autoToggle: false,
    class: 'k-tb__paneltoggle',
    onClick: () => state.leftOpen.set(!state.leftOpen.value),
  });
  const rightToggle = createIconButton({
    icon: 'panel-right',
    label: 'Right panel',
    shortcut: 'Tab',
    pressed: state.rightOpen.value,
    autoToggle: false,
    class: 'k-tb__paneltoggle',
    onClick: () => state.rightOpen.set(!state.rightOpen.value),
  });
  const developGroup = toolbarGroup(undo.el, redo.el, toolbarDivider(), before.el, leftToggle.el, rightToggle.el);
  developGroup.classList.add('k-tb__develop');
  d.add(() => [undo, redo, before, leftToggle, rightToggle].forEach((c) => c.destroy()));
  d.add(state.leftOpen.subscribe((v) => leftToggle.setPressed(v)));
  d.add(state.rightOpen.subscribe((v) => rightToggle.setPressed(v)));
  d.add(ctx.view.subscribe((v) => before.setPressed(v.compare !== 'off')));

  let unsubStore: (() => void) | null = null;
  const syncHistory = (): void => {
    const store = ctx.doc.value?.store;
    undo.setDisabled(!store?.canUndo());
    redo.setDisabled(!store?.canRedo());
  };
  d.add(
    ctx.doc.subscribe((doc) => {
      unsubStore?.();
      unsubStore = doc ? doc.store.subscribe(syncHistory) : null;
      syncHistory();
    }, true),
  );
  d.add(() => unsubStore?.());

  /* ---- right: theme, focus (lock), help, export ---- */
  const theme = createThemeToggle({ onChange: (c) => ctx.theme.set(c) });
  const lock = createIconButton({
    icon: 'lock',
    label: 'Focus mode — hide panels',
    shortcut: 'Shift+Tab',
    pressed: state.focusMode.value,
    autoToggle: false,
    class: 'k-tb__lock',
    onClick: () => state.focusMode.set(!state.focusMode.value),
  });
  d.add(
    state.focusMode.subscribe((v) => {
      lock.setPressed(v);
      lock.setIcon(v ? 'unlock' : 'lock');
      lock.setLabel(v ? 'Leave focus mode — show panels' : 'Focus mode — hide panels', 'Shift+Tab');
    }),
  );
  const help = createIconButton({ icon: 'question', label: 'Keyboard shortcuts', shortcut: '?', class: 'k-tb__help', onClick: () => actions.openHelp() });
  const exportBtn = createButton({ label: 'Export', icon: 'export', variant: 'primary', size: 'sm', class: 'k-tb__export', title: 'Export (Shift+⌘E)', onClick: () => ctx.openExportDialog() });
  let publishing = false;
  const publishBtn = actions.publish
    ? createButton({
        label: actions.publish.label ?? 'Save to gallery',
        icon: 'save',
        size: 'sm',
        class: 'k-tb__publish',
        disabled: !ctx.doc.value,
        onClick: () => {
          if (publishing || !ctx.doc.value) return;
          publishing = true;
          publishBtn?.setBusy(true);
          void Promise.resolve(actions.publish?.onPublish())
            .catch((error: unknown) => ctx.toast(`Could not save: ${error instanceof Error ? error.message : String(error)}`, 'error', 7000))
            .finally(() => {
              publishing = false;
              publishBtn?.setBusy(false);
              publishBtn?.setDisabled(!ctx.doc.value);
            });
        },
      })
    : null;
  d.add(ctx.doc.subscribe((doc) => publishBtn?.setDisabled(!doc || publishing)));
  d.add(() => [theme, lock, help, publishBtn, exportBtn].forEach((c) => c?.destroy()));

  // The drawer button is responsive-only, while a host-provided exit action
  // must remain available at every viewport size.
  const exitGroup = exitBtn ? toolbarGroup(exitBtn.el) : null;
  const drawerGroup = toolbarGroup(menuBtn.el);
  drawerGroup.classList.add('k-tb__drawer-group');
  const el = createToolbar({
    label: 'Toolbar',
    class: 'k-tb',
    children: [
      ...(exitGroup ? [exitGroup] : []),
      drawerGroup,
      arrows.el,
      crumbs.el,
      moduleSwitch.el,
      toolbarSpacer(),
      libraryGroup,
      developGroup,
      toolbarGroup(theme.el, lock.el, help.el),
      ...(publishBtn ? [publishBtn.el] : []),
      exportBtn.el,
    ],
  });

  /* ---- reactive bits ---- */
  const updateCrumbs = (): void => {
    const doc = ctx.doc.value;
    const items: Crumb[] = [];
    if (ctx.module.value === 'develop') {
      items.push({ label: 'Library', onClick: () => ctx.module.set('library') });
      const folder = doc?.record.folder;
      if (folder) for (const part of folder.split('/').filter(Boolean)) items.push({ label: part, onClick: () => ctx.module.set('library') });
      items.push({ label: doc ? doc.record.name : 'Develop' });
    } else {
      const path = state.libraryPath.value;
      items.push({ label: 'Library', onClick: path.length > 1 || path[0] !== 'All Photos' ? () => actions.libraryCrumb(-1) : undefined });
      path.forEach((label, i) => items.push({ label, onClick: i < path.length - 1 ? () => actions.libraryCrumb(i) : undefined }));
    }
    crumbs.set(items);
  };
  const updateNav = (): void => {
    const lib = ctx.module.value === 'library';
    arrows.setState({ back: !lib, forward: lib && !!rt.lastOpenedId.value, up: !lib || actions.canGoUp() });
    moduleSwitch.setValue(ctx.module.value, true);
    el.dataset.module = ctx.module.value;
  };
  d.add(ctx.module.subscribe(() => (updateCrumbs(), updateNav())));
  d.add(ctx.doc.subscribe(updateCrumbs));
  d.add(state.libraryPath.subscribe(() => (updateCrumbs(), updateNav())));
  d.add(rt.lastOpenedId.subscribe(updateNav));
  updateCrumbs();
  updateNav();

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}

/** "Add sample photos" — procedurally rendered demo images from the Library UI module. */
export async function addSamples(rt: AppRuntime): Promise<void> {
  const lib = await rt.features.load('libraryUi');
  if (!lib) {
    rt.ctx.toast('Sample photos are unavailable: the Library module could not be loaded.', 'error');
    return;
  }
  const task = rt.busy.begin('Rendering sample photos…');
  let files: File[] = [];
  try {
    files = await lib.createSamplePhotos();
  } catch (err) {
    rt.ctx.toast(`Could not create sample photos: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    task.end();
  }
  if (files.length) await rt.ctx.importFiles(files);
}
