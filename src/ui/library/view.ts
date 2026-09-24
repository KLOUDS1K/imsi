/**
 * Library content area, styled like the site's Archive page:
 *
 *   H1 (collection name) · muted one-line description · toolbar (filters,
 *   chips, search pill, sort, grid/list, size) · hairline ·
 *   FOLDERS n + yellow folder tiles (root collections with sub-folders) ·
 *   PHOTOS n + virtualized grid or list · empty states · drop-to-import.
 *
 * The shell may host the search pill and the grid/list toggle in its own
 * toolbar: bind them to librarySignals.search / librarySignals.viewMode and
 * pass `{ search: false, viewToggle: false }`.
 */
import type { AppContext } from '@/app/context';
import type { PhotoRecord } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import {
  createBadge,
  createButton,
  createEmptyState,
  createFolderTile,
  createSearchInput,
  createSectionLabel,
  createSegmentedControl,
  createSlider,
  icon,
  openMenu,
  type Component,
} from '@/ui/kit';
import { openInDevelop } from './actions';
import { filesFromDataTransfer } from './drop';
import { renderChips, createFilterPanel } from './filters';
import { countLabel } from './format';
import { createPhotoGrid, type PhotoGrid } from './grid';
import { createPhotoList, type PhotoList } from './list';
import { createSamplePhotos } from './samples';
import { setNavigator } from './selection';
import {
  activeFilterCount,
  collectionTitle,
  LIBRARY_SORTS,
  librarySignals,
  setLibraryCollection,
  SORT_LABELS,
  useLibraryQuery,
  type LibraryCollection,
  type LibraryViewMode,
} from './state';
import './view.css';

export interface LibraryViewOptions {
  /** Show the "Search by name" pill in the view's toolbar (default true). */
  search?: boolean;
  /** Show the grid/list segmented toggle in the view's toolbar (default true). */
  viewToggle?: boolean;
}

const DESCRIPTIONS: Record<string, string> = {
  all: 'Import photos, rate and pick, then open one to edit. Originals are never changed.',
  favorites: 'Photos you marked with a heart (H).',
  picks: 'Photos flagged as picks (P).',
  recent: 'Photos edited in the last seven days.',
  rejected: 'Photos flagged as rejected (X). Remove them from the library when you are sure.',
  unedited: 'Photos without develop settings yet.',
};

function describe(ctx: AppContext, c: LibraryCollection): string {
  if (c.kind === 'folder') return `Photos in ${c.path.split('/').join(' / ')} and its sub-folders.`;
  if (c.kind === 'album') return 'Album. Drag photos onto it in the sidebar, or use Add to album in the photo menu.';
  return DESCRIPTIONS[c.kind] ?? DESCRIPTIONS.all;
}

export function createLibraryView(ctx: AppContext, opts: LibraryViewOptions = {}): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const query = useLibraryQuery(ctx);
  d.add(query.release);

  /* ---------------- header & toolbar ---------------- */
  const title = h('h1', { class: 'k-h1 k-lib__title' });
  const desc = h('p', { class: 'k-desc k-lib__desc' });

  const filterBadge = createBadge(0, { tone: 'accent' });
  const filterBtn = h(
    'button',
    { type: 'button', class: 'k-lib__filterbtn', attrs: { 'aria-expanded': 'false', 'aria-controls': 'k-lib-filters' } },
    icon('filter', 14),
    h('span', {}, 'Filter'),
    filterBadge.el,
  );
  d.add(on(filterBtn, 'click', () => librarySignals.filterOpen.set(!librarySignals.filterOpen.value)));
  const chips = h('div', { class: 'k-lib__chips' });

  const search = opts.search === false ? null : createSearchInput({ value: librarySignals.search.value, width: '220px', onInput: (v) => librarySignals.search.set(v) });
  if (search) {
    d.add(librarySignals.search.subscribe((v) => v !== search.getValue() && search.setValue(v, true)));
    d.add(() => search.destroy());
  }

  const sortBtn = h('button', { type: 'button', class: 'k-lib__iconbtn', attrs: { 'aria-label': 'Sort', title: 'Sort' } }, icon('arrow-up-down', 16));
  d.add(
    on(sortBtn, 'click', () => {
      const cur = librarySignals.sort.value;
      openMenu(
        sortBtn,
        [
          { kind: 'header', label: 'Sort by' },
          ...LIBRARY_SORTS.map((k) => ({ label: SORT_LABELS[k], checked: cur.key === k, onSelect: () => librarySignals.sort.set({ ...librarySignals.sort.value, key: k }) })),
          ...(LIBRARY_SORTS.includes(cur.key as never) ? [] : [{ label: SORT_LABELS[cur.key], checked: true }]),
          { kind: 'separator' },
          { label: 'Ascending', icon: 'arrow-up', checked: cur.order === 'asc', onSelect: () => librarySignals.sort.set({ ...librarySignals.sort.value, order: 'asc' }) },
          { label: 'Descending', icon: 'arrow-down', checked: cur.order === 'desc', onSelect: () => librarySignals.sort.set({ ...librarySignals.sort.value, order: 'desc' }) },
        ],
        { placement: 'bottom-end' },
      );
    }),
  );

  const viewSeg =
    opts.viewToggle === false
      ? null
      : createSegmentedControl<LibraryViewMode>({
          ariaLabel: 'View',
          size: 'sm',
          value: librarySignals.viewMode.value,
          options: [
            { value: 'grid', icon: 'grid', title: 'Grid (G)' },
            { value: 'list', icon: 'list', title: 'List' },
          ],
          onChange: (v) => librarySignals.viewMode.set(v),
        });
  if (viewSeg) {
    d.add(librarySignals.viewMode.subscribe((v) => viewSeg.setValue(v, true)));
    d.add(() => viewSeg.destroy());
  }

  const sizeSlider = createSlider({
    label: 'Size',
    min: 120,
    max: 320,
    step: 4,
    value: librarySignals.thumbSize.value,
    defaultValue: 184,
    fill: 'min',
    format: (v) => `${Math.round(v)}`,
    ariaLabel: 'Thumbnail size',
    onInput: (v) => librarySignals.thumbSize.set(v),
  });
  sizeSlider.el.classList.add('k-lib__size');
  d.add(() => sizeSlider.destroy());

  const importBtn = createButton({ label: 'Import', icon: 'upload', size: 'sm', variant: 'primary', onClick: () => void ctx.importFiles() });
  d.add(() => importBtn.destroy());

  const toolbar = h(
    'div',
    { class: 'k-lib__toolbar' },
    h('div', { class: 'k-lib__toolbar-start' }, filterBtn, chips),
    h('div', { class: 'k-lib__toolbar-end' }, search?.el ?? null, sizeSlider.el, sortBtn, viewSeg?.el ?? null, importBtn.el),
  );
  const filters = createFilterPanel(ctx);
  filters.el.id = 'k-lib-filters';
  d.add(() => filters.dispose());

  /* ---------------- sections ---------------- */
  const folderLabelHost = h('div', {});
  const folderTiles = h('div', { class: 'k-lib__folders' });
  const foldersSection = h('section', { class: 'k-lib__section' }, folderLabelHost, folderTiles);
  const photosLabelHost = h('div', {});
  const photosHost = h('div', { class: 'k-lib__photos' });
  const photosSection = h('section', { class: 'k-lib__section k-lib__section--photos' }, photosLabelHost, photosHost);
  const emptyHost = h('div', { class: 'k-lib__empty' });

  const inner = h(
    'div',
    { class: 'k-lib__inner' },
    h('header', { class: 'k-lib__head' }, title, desc),
    toolbar,
    filters.el,
    h('hr', { class: 'k-divider k-lib__rule' }),
    foldersSection,
    photosSection,
    emptyHost,
  );
  const scroll = h('div', { class: 'k-lib__scroll' }, inner);
  const dropOverlay = h('div', { class: 'k-lib__drop', hidden: true }, h('div', { class: 'k-lib__drop-card' }, icon('upload', 22), h('span', {}, 'Drop photos or folders to import')));
  const el = h('div', { class: 'k-lib' }, scroll, dropOverlay);

  /* ---------------- grid / list ---------------- */
  let view: (PhotoGrid | PhotoList) | null = null;
  let mode: LibraryViewMode | null = null;
  const open = (id: string): void => void openInDevelop(ctx, id);
  const mountView = (m: LibraryViewMode): void => {
    if (mode === m && view) return;
    view?.dispose();
    mode = m;
    const v = m === 'grid' ? createPhotoGrid({ ctx, scrollEl: scroll, onOpen: open }) : createPhotoList({ ctx, scrollEl: scroll, onOpen: open });
    view = v;
    photosHost.replaceChildren(v.el);
    v.setRecords(query.records.value);
    sizeSlider.el.hidden = m !== 'grid';
    setNavigator(ctx, {
      el: m === 'grid' ? v.el : (v.el.querySelector<HTMLElement>('.k-list__body') ?? v.el),
      columns: () => (m === 'grid' ? (v as PhotoGrid).columns() : 1),
      pageRows: () => v.pageRows(),
      reveal: (id) => v.reveal(id),
    });
  };
  d.add(librarySignals.viewMode.subscribe(mountView, true));
  d.add(() => {
    view?.dispose();
    setNavigator(ctx, null);
  });

  /* ---------------- rendering ---------------- */
  let tiles: Component[] = [];
  let emptyComp: Component | null = null;

  const renderFolders = (): void => {
    for (const t of tiles) t.destroy();
    tiles = [];
    const c = librarySignals.collection.value;
    const parent = c.kind === 'folder' ? c.path : c.kind === 'all' ? '' : null;
    const hasFilter = activeFilterCount(librarySignals.filters.value) > 0 || !!librarySignals.search.value.trim();
    if (parent === null || hasFilter) {
      foldersSection.hidden = true;
      return;
    }
    const prefix = parent ? `${parent}/` : '';
    const children = ctx.library.folders().filter((f) => f.startsWith(prefix) && f.length > prefix.length && !f.slice(prefix.length).includes('/'));
    foldersSection.hidden = children.length === 0;
    if (!children.length) return;
    const counts = new Map<string, number>();
    for (const r of ctx.library.all()) {
      for (const f of children) if (r.folder === f || r.folder.startsWith(`${f}/`)) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    folderLabelHost.replaceChildren(createSectionLabel('Folders', children.length));
    const narrow = el.clientWidth > 0 && el.clientWidth < 520;
    for (const f of children) {
      const tile = createFolderTile({
        name: f.slice(prefix.length),
        sub: countLabel(counts.get(f) ?? 0),
        size: narrow ? 'md' : 'lg',
        onOpen: () => setLibraryCollection({ kind: 'folder', path: f }),
      });
      tile.el.dataset.folder = f;
      tiles.push(tile);
      folderTiles.append(tile.el);
    }
  };

  const renderEmpty = (recs: PhotoRecord[]): void => {
    emptyComp?.destroy();
    emptyComp = null;
    const libraryEmpty = ctx.library.all().length === 0;
    photosSection.hidden = recs.length === 0;
    toolbar.hidden = libraryEmpty;
    if (recs.length > 0) return;
    if (libraryEmpty) {
      const imp = createButton({ label: 'Import photos', icon: 'upload', variant: 'primary', onClick: () => void ctx.importFiles() });
      const samples = createButton({
        label: 'Add sample photos',
        icon: 'images',
        onClick: async () => {
          samples.setBusy(true);
          try {
            await ctx.importFiles(await createSamplePhotos());
          } catch (err) {
            ctx.toast(`Could not create the samples: ${String(err)}`, 'error');
          } finally {
            samples.setBusy(false);
          }
        },
      });
      samples.el.dataset.action = 'samples';
      const state = createEmptyState({
        title: 'No photos yet',
        description:
          'Drop photos or whole folders anywhere here, or import them from your device. JPEG, PNG, WebP, TIFF, HEIC and RAW files (ARW, CR2, CR3, NEF, DNG, RAF, ORF, RW2…) stay on this device — originals are never changed.',
        art: 'folder',
        glyph: 'plus',
        actions: [imp.el, samples.el],
      });
      emptyComp = { el: state.el, destroy: () => (imp.destroy(), samples.destroy(), state.destroy()) };
    } else {
      const clear = createButton({
        label: 'Clear filters',
        size: 'sm',
        onClick: () => {
          librarySignals.filters.set({});
          librarySignals.search.set('');
        },
      });
      const all = createButton({ label: 'Show all photos', size: 'sm', variant: 'ghost', onClick: () => setLibraryCollection({ kind: 'all' }) });
      const state = createEmptyState({ title: 'No photos here', description: 'Nothing matches the current collection, search and filters.', art: 'search', compact: true, actions: [clear.el, all.el] });
      emptyComp = { el: state.el, destroy: () => (clear.destroy(), all.destroy(), state.destroy()) };
    }
    emptyHost.replaceChildren(emptyComp.el);
  };

  const renderHeader = (): void => {
    const c = librarySignals.collection.value;
    title.textContent = collectionTitle(ctx, c);
    desc.textContent = describe(ctx, c);
    const f = librarySignals.filters.value;
    const n = activeFilterCount(f);
    filterBadge.set(n ? String(n) : '');
    filterBadge.el.hidden = n === 0;
    filterBtn.classList.toggle('is-active', n > 0 || librarySignals.filterOpen.value);
    filterBtn.setAttribute('aria-expanded', String(librarySignals.filterOpen.value));
    renderChips(chips, f);
  };

  const renderAll = (): void => {
    const recs = query.records.value;
    renderHeader();
    renderFolders();
    photosLabelHost.replaceChildren(createSectionLabel('Photos', recs.length.toLocaleString()));
    renderEmpty(recs);
    view?.setRecords(recs);
  };

  d.add(query.records.subscribe(renderAll));
  d.add(librarySignals.filters.subscribe(renderHeader));
  d.add(librarySignals.filterOpen.subscribe(renderHeader));
  d.add(ctx.library.subscribe(() => filters.refresh()));
  d.add(
    librarySignals.collection.subscribe(() => {
      scroll.scrollTop = 0;
    }),
  );
  renderAll();

  /* ---------------- drop to import ---------------- */
  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  d.add(
    on(el, 'dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      dropOverlay.hidden = false;
    }),
  );
  d.add(
    on(el, 'dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }),
  );
  d.add(
    on(el, 'dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.hidden = true;
    }),
  );
  d.add(
    on(el, 'drop', (e) => {
      dragDepth = 0;
      dropOverlay.hidden = true;
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      // The shell may also listen for drops: this one is handled.
      e.stopPropagation();
      void filesFromDataTransfer(e.dataTransfer).then((files) => {
        if (files.length) void ctx.importFiles(files);
      });
    }),
  );

  return {
    el,
    dispose() {
      for (const t of tiles) t.destroy();
      emptyComp?.destroy();
      d.dispose();
      el.remove();
    },
  };
}
