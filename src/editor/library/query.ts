/**
 * Library filtering, sorting and facets — pure functions over PhotoRecords.
 *
 * Semantics (documented for the grid / filter bar):
 * - `text`: every term must match (AND) somewhere in name, folder, camera,
 *   make/model, lens, file format, dateTaken (ISO, so "2026-03" works) or the
 *   names of the photo's albums. Case- and diacritic-insensitive; "quoted
 *   phrases" stay together.
 * - `folder`: that folder AND its subfolders.
 * - Ranges are inclusive. A photo without the value (no EXIF ISO…) is excluded
 *   while that range filter is set.
 * - `camera` / `lens`: case-insensitive equality with the facet values.
 * - `dateRange`: compared at the precision of each bound ("2026-03" … "2026-03"
 *   = all of March). Photos without EXIF date use the file's modified time.
 * - `edited: 'recent'`: edited within the last 7 days.
 * - `flag: 'any'` (or undefined) = no flag filter.
 * - Sorting is stable and deterministic: ties fall back to capture date, then
 *   name, then id, all in the requested direction, so flipping asc/desc exactly
 *   reverses the list. Photos lacking the sort value (no ISO, never edited…)
 *   always go last.
 */
import type { LibraryFacets } from '@/editor/contracts';
import type { LibraryQuery, LibrarySort, PhotoMeta, PhotoRecord } from '@/editor/types';
import { expandFolders, isInFolder, normalizeFolder } from './folders';
import { foldText, parseSearchTerms } from './text';

export const RECENT_EDIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Default direction when a query gives a sort but no order: newest/biggest first, alphabetic A→Z. */
export const DEFAULT_SORT_ORDER: Record<LibrarySort, 'asc' | 'desc'> = {
  'date-taken': 'desc',
  'date-added': 'desc',
  edited: 'desc',
  name: 'asc',
  rating: 'desc',
  size: 'desc',
  camera: 'asc',
  iso: 'asc',
  'focal-length': 'asc',
};

export const DEFAULT_SORT: LibrarySort = 'date-taken';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Display name of the camera: meta.camera, else "Make Model" (make not repeated). */
export function cameraName(meta: PhotoMeta | undefined): string | undefined {
  if (!meta) return undefined;
  if (meta.camera && meta.camera.trim()) return meta.camera.trim();
  const make = meta.make?.trim() ?? '';
  const model = meta.model?.trim() ?? '';
  if (!make && !model) return undefined;
  if (make && model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return [make, model].filter(Boolean).join(' ');
}

/** Local "YYYY-MM-DDTHH:mm:ss" (the EXIF convention: local time, no zone). */
export function localIsoString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Capture date as an ISO string, falling back to the file's modified time. */
export function effectiveDate(r: PhotoRecord): string {
  const t = r.meta?.dateTaken;
  if (typeof t === 'string' && t.length >= 4) return t;
  return localIsoString(r.modified || r.added);
}

const dateMsCache = new WeakMap<PhotoRecord, number>();

/** Capture time in ms (EXIF local time parsed as local), falling back to modified/added. */
export function effectiveDateMs(r: PhotoRecord): number {
  let v = dateMsCache.get(r);
  if (v === undefined) {
    const parsed = r.meta?.dateTaken ? Date.parse(r.meta.dateTaken) : NaN;
    v = Number.isFinite(parsed) ? parsed : r.modified || r.added || 0;
    dateMsCache.set(r, v);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Text search                                                         */
/* ------------------------------------------------------------------ */

// Records are immutable (every update replaces the object), so a WeakMap cache stays correct.
const haystackCache = new WeakMap<PhotoRecord, string>();

function haystack(r: PhotoRecord): string {
  let h = haystackCache.get(r);
  if (h === undefined) {
    const m = r.meta ?? ({} as PhotoMeta);
    h = foldText(
      [r.name, r.folder, cameraName(m), m.make, m.model, m.lens, m.lensMake, m.format, m.rawFormat, m.dateTaken]
        .filter((s): s is string => typeof s === 'string' && s !== '')
        .join('\n'),
    );
    haystackCache.set(r, h);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export interface QueryContext {
  /** Album id → folded album name (for text search). */
  albumNames: ReadonlyMap<string, string>;
  now: number;
}

function inRange(v: number | undefined, range: [number, number] | undefined): boolean {
  if (!range) return true;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  // Relative tolerance: shutter/aperture facets round-trip through floats (1/250 = 0.004).
  const eps = 1e-9 * Math.max(1, Math.abs(v));
  return v >= lo - eps && v <= hi + eps;
}

function inDateRange(date: string, range: [string, string] | undefined): boolean {
  if (!range) return true;
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
  // Compare at each bound's precision: the end bound "2026-03-31" includes that whole day.
  if (a && date.slice(0, a.length) < a) return false;
  if (b && date.slice(0, b.length) > b) return false;
  return true;
}

const eqi = (a: string | undefined, b: string) => !!a && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Compile a query into a predicate (terms parsed once). */
export function compileFilter(q: LibraryQuery, ctx: QueryContext): (r: PhotoRecord) => boolean {
  const terms = parseSearchTerms(q.text);
  const folder = q.folder !== undefined ? normalizeFolder(q.folder) : undefined;
  const labels = q.labels && q.labels.length > 0 ? new Set(q.labels) : null;
  const minRating = typeof q.minRating === 'number' && q.minRating > 0 ? q.minRating : 0;
  const flag = q.flag && q.flag !== 'any' ? q.flag : null;
  const camera = q.camera?.trim() || null;
  const lens = q.lens?.trim() || null;
  const recentSince = ctx.now - RECENT_EDIT_MS;

  return (r) => {
    if (q.albumId !== undefined && !r.albumIds.includes(q.albumId)) return false;
    if (folder !== undefined && folder !== '' && !isInFolder(r.folder, folder)) return false;
    if (q.favorite !== undefined && r.favorite !== q.favorite) return false;
    if (minRating > 0 && r.rating < minRating) return false;
    if (flag && r.flag !== flag) return false;
    if (labels && (!r.label || !labels.has(r.label))) return false;
    if (camera && !eqi(cameraName(r.meta), camera)) return false;
    if (lens && !eqi(r.meta?.lens?.trim(), lens)) return false;
    if (q.isoRange && !inRange(r.meta?.iso, q.isoRange)) return false;
    if (q.apertureRange && !inRange(r.meta?.aperture, q.apertureRange)) return false;
    if (q.shutterRange && !inRange(r.meta?.shutter, q.shutterRange)) return false;
    if (q.focalRange && !inRange(r.meta?.focalLength, q.focalRange)) return false;
    if (q.dateRange && !inDateRange(effectiveDate(r), q.dateRange)) return false;
    if (q.edited === 'edited' && !r.hasEdits) return false;
    if (q.edited === 'unedited' && r.hasEdits) return false;
    if (q.edited === 'recent' && !(r.hasEdits && (r.editedAt ?? 0) >= recentSince)) return false;
    if (terms.length > 0) {
      const h = haystack(r);
      for (const t of terms) {
        if (h.includes(t)) continue;
        if (r.albumIds.some((id) => ctx.albumNames.get(id)?.includes(t))) continue;
        return false;
      }
    }
    return true;
  };
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

type SortKey = number | string | undefined;

function sortKey(r: PhotoRecord, sort: LibrarySort): SortKey {
  switch (sort) {
    case 'date-taken':
      return effectiveDateMs(r);
    case 'date-added':
      return r.added;
    case 'edited':
      return r.hasEdits ? r.editedAt : undefined;
    case 'name':
      return r.name;
    case 'rating':
      return r.rating;
    case 'size':
      return r.size;
    case 'camera':
      return cameraName(r.meta);
    case 'iso':
      return r.meta?.iso;
    case 'focal-length':
      return r.meta?.focalLength;
  }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return 0;
}

const isMissing = (k: SortKey) => k === undefined || (typeof k === 'number' && !Number.isFinite(k)) || k === '';

/** Sort a copy of `records`. */
export function sortRecords(records: readonly PhotoRecord[], sort: LibrarySort = DEFAULT_SORT, order?: 'asc' | 'desc'): PhotoRecord[] {
  const dir = (order ?? DEFAULT_SORT_ORDER[sort] ?? 'asc') === 'desc' ? -1 : 1;
  // Decorate once: key extraction (dates, camera names) is not free and sort compares O(n log n) times.
  const rows = records.map((r) => ({ r, k: sortKey(r, sort), t: effectiveDateMs(r) }));
  rows.sort((a, b) => {
    const am = isMissing(a.k);
    const bm = isMissing(b.k);
    if (am !== bm) return am ? 1 : -1;
    let c = am ? 0 : compareKeys(a.k, b.k);
    if (c === 0) c = a.t - b.t;
    if (c === 0) c = collator.compare(a.r.name, b.r.name);
    if (c === 0) c = a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
    return dir * c;
  });
  return rows.map((row) => row.r);
}

/** Filter + sort. */
export function runQuery(records: readonly PhotoRecord[], q: LibraryQuery, ctx: QueryContext): PhotoRecord[] {
  const pred = compileFilter(q, ctx);
  return sortRecords(
    records.filter((r) => pred(r)),
    q.sort ?? DEFAULT_SORT,
    q.order,
  );
}

/* ------------------------------------------------------------------ */
/* Facets                                                              */
/* ------------------------------------------------------------------ */

function sortedNumbers(set: Set<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function addNumber(set: Set<number>, v: number | undefined): void {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) set.add(v);
}

/** Distinct values present in `records` (for the filter bar). */
export function computeFacets(records: readonly PhotoRecord[]): LibraryFacets {
  // Case-insensitive distinct strings, keeping the first spelling seen.
  const cameras = new Map<string, string>();
  const lenses = new Map<string, string>();
  const isos = new Set<number>();
  const apertures = new Set<number>();
  const shutters = new Set<number>();
  const focals = new Set<number>();
  const folders = new Set<string>();
  let dateMin: string | undefined;
  let dateMax: string | undefined;
  for (const r of records) {
    const m = r.meta;
    const cam = cameraName(m);
    if (cam && !cameras.has(cam.toLowerCase())) cameras.set(cam.toLowerCase(), cam);
    const lens = m?.lens?.trim();
    if (lens && !lenses.has(lens.toLowerCase())) lenses.set(lens.toLowerCase(), lens);
    addNumber(isos, m?.iso);
    addNumber(apertures, m?.aperture);
    addNumber(shutters, m?.shutter);
    addNumber(focals, m?.focalLength);
    if (r.folder) folders.add(r.folder);
    const d = effectiveDate(r);
    if (dateMin === undefined || d < dateMin) dateMin = d;
    if (dateMax === undefined || d > dateMax) dateMax = d;
  }
  const facets: LibraryFacets = {
    cameras: [...cameras.values()].sort(collator.compare),
    lenses: [...lenses.values()].sort(collator.compare),
    isos: sortedNumbers(isos),
    apertures: sortedNumbers(apertures),
    shutters: sortedNumbers(shutters),
    focalLengths: sortedNumbers(focals),
    folders: expandFolders(folders),
  };
  if (dateMin !== undefined) facets.dateMin = dateMin;
  if (dateMax !== undefined) facets.dateMax = dateMax;
  return facets;
}
