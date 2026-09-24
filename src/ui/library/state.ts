/**
 * Library UI state shared by the sidebar, the content view, the filmstrip and
 * the shell's toolbar.
 *
 * `librarySignals` is a module singleton (one editor per page):
 * - `collection`  — what the sidebar selected (All Photos, a folder, an album…)
 * - `search`      — "Search by name" text. The shell may host the search pill in
 *                   its toolbar: bind it to this signal or call setLibrarySearch().
 * - `viewMode`    — 'grid' | 'list' (bind the toolbar's segmented control here)
 * - `sort`        — { key, order }; keys beyond LibrarySort (lens, aperture,
 *                   shutter, label) are sorted client-side
 * - `filters`     — the filter bar (rating ≥, flag, labels, camera, …)
 * - `thumbSize`   — minimum grid tile width in CSS px (120..320)
 * - `filterOpen`  — whether the filter panel is expanded
 *
 * `useLibraryQuery(ctx)` runs the query (library + signals) and keeps
 * `ctx.visibleIds` in sync. It is ref-counted per context: every component that
 * shows photos acquires it and releases it on dispose.
 */
import type { AppContext } from '@/app/context';
import type { ColorLabel, LibraryQuery, LibrarySort, PhotoRecord } from '@/editor/types';
import { loadLocal, saveLocal } from '@/ui/kit';
import { Signal } from '@/ui/signal';

export type SimpleCollection = 'all' | 'favorites' | 'picks' | 'recent' | 'rejected' | 'unedited';
export type LibraryCollection = { kind: SimpleCollection } | { kind: 'folder'; path: string } | { kind: 'album'; id: string };

/** List-view columns sortable in addition to LibrarySort. */
export type ExtraSortKey = 'lens' | 'aperture' | 'shutter' | 'label';
export type SortKey = LibrarySort | ExtraSortKey;
export interface LibrarySortState {
  key: SortKey;
  order: 'asc' | 'desc';
}

export type LibraryFilters = Pick<
  LibraryQuery,
  'minRating' | 'flag' | 'labels' | 'camera' | 'lens' | 'isoRange' | 'apertureRange' | 'shutterRange' | 'focalRange' | 'dateRange' | 'edited'
>;

export type LibraryViewMode = 'grid' | 'list';

export const LIBRARY_SORTS: readonly LibrarySort[] = ['date-taken', 'date-added', 'edited', 'name', 'rating', 'size', 'camera', 'iso', 'focal-length'];
export const SORT_LABELS: Record<SortKey, string> = {
  'date-taken': 'Capture date',
  'date-added': 'Import date',
  edited: 'Edit date',
  name: 'File name',
  rating: 'Rating',
  size: 'File size',
  camera: 'Camera',
  iso: 'ISO',
  'focal-length': 'Focal length',
  lens: 'Lens',
  aperture: 'Aperture',
  shutter: 'Shutter speed',
  label: 'Color label',
};

export const SIMPLE_COLLECTIONS: { kind: SimpleCollection; label: string; icon: 'images' | 'heart' | 'flag' | 'history' | 'flag-x' | 'circle' }[] = [
  { kind: 'all', label: 'All Photos', icon: 'images' },
  { kind: 'favorites', label: 'Favorites', icon: 'heart' },
  { kind: 'picks', label: 'Picks', icon: 'flag' },
  { kind: 'recent', label: 'Recently Edited', icon: 'history' },
  { kind: 'rejected', label: 'Rejected', icon: 'flag-x' },
  { kind: 'unedited', label: 'Unedited', icon: 'circle' },
];

const LS_VIEW = 'kloud-library:view';
const LS_SORT = 'kloud-library:sort';
const LS_SIZE = 'kloud-library:thumb';

function isSortState(v: unknown): v is LibrarySortState {
  return !!v && typeof v === 'object' && typeof (v as LibrarySortState).key === 'string' && ((v as LibrarySortState).order === 'asc' || (v as LibrarySortState).order === 'desc');
}

function initialSort(): LibrarySortState {
  const v = loadLocal<unknown>(LS_SORT, null);
  return isSortState(v) && v.key in SORT_LABELS ? v : { key: 'date-taken', order: 'desc' };
}

export const librarySignals = {
  collection: new Signal<LibraryCollection>({ kind: 'all' }),
  search: new Signal<string>(''),
  viewMode: new Signal<LibraryViewMode>(loadLocal<LibraryViewMode>(LS_VIEW, 'grid') === 'list' ? 'list' : 'grid'),
  sort: new Signal<LibrarySortState>(initialSort()),
  filters: new Signal<LibraryFilters>({}),
  thumbSize: new Signal<number>(Math.min(320, Math.max(120, Number(loadLocal<number>(LS_SIZE, 184)) || 184))),
  filterOpen: new Signal<boolean>(false),
};
export type LibrarySignals = typeof librarySignals;

librarySignals.viewMode.subscribe((v) => saveLocal(LS_VIEW, v));
librarySignals.sort.subscribe((v) => saveLocal(LS_SORT, v));
librarySignals.thumbSize.subscribe((v) => saveLocal(LS_SIZE, v));

/** For the shell's toolbar search pill. */
export function setLibrarySearch(text: string): void {
  librarySignals.search.set(text);
}

export function setLibraryCollection(c: LibraryCollection): void {
  const cur = librarySignals.collection.value;
  if (sameCollection(cur, c)) return;
  librarySignals.collection.set(c);
}

export function sameCollection(a: LibraryCollection, b: LibraryCollection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.path === b.path;
  if (a.kind === 'album' && b.kind === 'album') return a.id === b.id;
  return true;
}

/** Number of active filters (for the Filter button badge). */
export function activeFilterCount(f: LibraryFilters): number {
  let n = 0;
  if (f.minRating) n++;
  if (f.flag && f.flag !== 'any') n++;
  if (f.labels?.length) n++;
  for (const k of ['camera', 'lens', 'isoRange', 'apertureRange', 'shutterRange', 'focalRange', 'dateRange', 'edited'] as const) if (f[k]) n++;
  return n;
}

export function collectionQuery(c: LibraryCollection): Partial<LibraryQuery> {
  switch (c.kind) {
    case 'all':
      return {};
    case 'favorites':
      return { favorite: true };
    case 'picks':
      return { flag: 'pick' };
    case 'recent':
      return { edited: 'recent' };
    case 'rejected':
      return { flag: 'reject' };
    case 'unedited':
      return { edited: 'unedited' };
    case 'folder':
      return { folder: c.path };
    case 'album':
      return { albumId: c.id };
  }
}

const isLibrarySort = (k: SortKey): k is LibrarySort => (LIBRARY_SORTS as readonly string[]).includes(k);

/** Filters AND collection AND search; the collection wins where both set the same field. */
export function buildLibraryQuery(s: LibrarySignals = librarySignals): LibraryQuery {
  const sort = s.sort.value;
  const q: LibraryQuery = { ...s.filters.value, ...collectionQuery(s.collection.value) };
  const text = s.search.value.trim();
  if (text) q.text = text;
  if (isLibrarySort(sort.key)) {
    q.sort = sort.key;
    q.order = sort.order;
  }
  return q;
}

const LABEL_ORDER: Record<ColorLabel, number> = { red: 0, yellow: 1, green: 2, blue: 3, purple: 4 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Client-side sort for list columns the library query does not know. Missing values always sort last. */
export function sortExtra(records: PhotoRecord[], key: ExtraSortKey, order: 'asc' | 'desc'): PhotoRecord[] {
  const dir = order === 'desc' ? -1 : 1;
  const keyOf = (r: PhotoRecord): string | number | undefined => {
    switch (key) {
      case 'lens':
        return r.meta?.lens || undefined;
      case 'aperture':
        return r.meta?.aperture;
      case 'shutter':
        return r.meta?.shutter;
      case 'label':
        return r.label ? LABEL_ORDER[r.label] : undefined;
    }
  };
  const rows = records.map((r) => ({ r, k: keyOf(r) }));
  rows.sort((a, b) => {
    const am = a.k === undefined;
    const bm = b.k === undefined;
    if (am !== bm) return am ? 1 : -1;
    let c = 0;
    if (!am) c = typeof a.k === 'string' && typeof b.k === 'string' ? collator.compare(a.k, b.k) : Number(a.k) - Number(b.k);
    if (c === 0) c = collator.compare(a.r.name, b.r.name);
    return dir * c;
  });
  return rows.map((x) => x.r);
}

/* ------------------------------------------------------------------ */
/* Query controller                                                    */
/* ------------------------------------------------------------------ */

interface QueryController {
  records: Signal<PhotoRecord[]>;
  refs: number;
  refresh(): void;
  stop(): void;
}

const controllers = new WeakMap<AppContext, QueryController>();

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function startController(ctx: AppContext): QueryController {
  const records = new Signal<PhotoRecord[]>([]);
  let queued = false;
  const run = (): void => {
    queued = false;
    const sort = librarySignals.sort.value;
    let recs = ctx.library.query(buildLibraryQuery());
    if (!isLibrarySort(sort.key)) recs = sortExtra(recs, sort.key, sort.order);
    records.set(recs);
    const ids = recs.map((r) => r.id);
    if (!sameIds(ids, ctx.visibleIds.value)) ctx.visibleIds.set(ids);
    // Drop ids that left the library; in Library mode also those filtered out of view.
    const sel = ctx.selection.value;
    if (sel.length > 0) {
      const keep = ctx.module.value === 'library' ? new Set(ids) : null;
      const next = sel.filter((id) => (keep ? keep.has(id) : !!ctx.library.get(id)));
      if (next.length !== sel.length) ctx.selection.set(next);
    }
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  };
  const offs = [
    ctx.library.subscribe(schedule),
    librarySignals.collection.subscribe(schedule),
    librarySignals.search.subscribe(schedule),
    librarySignals.sort.subscribe(schedule),
    librarySignals.filters.subscribe(schedule),
  ];
  run();
  return {
    records,
    refs: 0,
    refresh: schedule,
    stop: () => offs.forEach((f) => f()),
  };
}

/** Acquire the shared query for `ctx` (keeps ctx.visibleIds in sync while held). */
export function useLibraryQuery(ctx: AppContext): { records: Signal<PhotoRecord[]>; release: () => void } {
  let c = controllers.get(ctx);
  if (!c) {
    c = startController(ctx);
    controllers.set(ctx, c);
  }
  c.refs++;
  let released = false;
  const ctrl = c;
  return {
    records: ctrl.records,
    release: () => {
      if (released) return;
      released = true;
      if (--ctrl.refs <= 0) {
        ctrl.stop();
        controllers.delete(ctx);
      }
    },
  };
}

/** Human name of the current collection (the H1). */
export function collectionTitle(ctx: AppContext, c: LibraryCollection): string {
  if (c.kind === 'folder') return c.path.split('/').pop() || 'Folder';
  if (c.kind === 'album') return ctx.library.albums().find((a) => a.id === c.id)?.name ?? 'Album';
  return SIMPLE_COLLECTIONS.find((s) => s.kind === c.kind)?.label ?? 'All Photos';
}
