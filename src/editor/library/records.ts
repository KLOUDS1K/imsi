/**
 * PhotoRecord / Album validation and patching. Records read from storage or
 * handed in by callers are never trusted blindly: an old or corrupted record
 * must not break queries for the whole library.
 */
import { createEmptyMeta } from '@/editor/defaults';
import type { Album, ColorLabel, PhotoMeta, PhotoRecord, PickFlag } from '@/editor/types';
import { normalizeFolder } from './folders';

export const COLOR_LABELS: readonly ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];
export const PICK_FLAGS: readonly PickFlag[] = ['none', 'pick', 'reject'];

export function isColorLabel(v: unknown): v is ColorLabel {
  return typeof v === 'string' && (COLOR_LABELS as readonly string[]).includes(v);
}

export function isPickFlag(v: unknown): v is PickFlag {
  return typeof v === 'string' && (PICK_FLAGS as readonly string[]).includes(v);
}

export function clampRating(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

/** Random unique id (crypto.randomUUID when available). */
export function newId(prefix = ''): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const uuid =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Whether a record's source is a RAW file (drives RAW-specific default params). */
export function isRawRecord(r: Pick<PhotoRecord, 'meta'>): boolean {
  return r.meta?.format === 'raw';
}

const finiteOr = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);

function uniqueStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
}

/** Repair a stored record (fills fields added by later versions); null when unusable. */
export function sanitizeRecord(raw: unknown): PhotoRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PhotoRecord>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const name = typeof r.name === 'string' && r.name ? r.name : (r.meta?.fileName ?? 'Untitled');
  const meta: PhotoMeta = r.meta && typeof r.meta === 'object' ? r.meta : createEmptyMeta(name);
  const added = finiteOr(r.added, 0);
  const rec: PhotoRecord = {
    id: r.id,
    name,
    folder: normalizeFolder(r.folder),
    size: finiteOr(r.size, meta.fileSize ?? 0),
    type: typeof r.type === 'string' ? r.type : (meta.mimeType ?? ''),
    added,
    modified: finiteOr(r.modified, added),
    meta,
    rating: clampRating(r.rating),
    flag: isPickFlag(r.flag) ? r.flag : 'none',
    label: isColorLabel(r.label) ? r.label : null,
    favorite: r.favorite === true,
    albumIds: uniqueStrings(r.albumIds),
    hasEdits: r.hasEdits === true,
  };
  if (typeof r.editedAt === 'number' && Number.isFinite(r.editedAt)) rec.editedAt = r.editedAt;
  return rec;
}

export function sanitizeAlbum(raw: unknown): Album | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<Album>;
  if (typeof a.id !== 'string' || !a.id) return null;
  const album: Album = {
    id: a.id,
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'Untitled album',
    created: finiteOr(a.created, 0),
  };
  if (typeof a.coverId === 'string' && a.coverId) album.coverId = a.coverId;
  return album;
}

const sameArray = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Validated shallow merge of `patch` into `rec`. `id` can never change;
 * invalid values are ignored. Returns `rec` itself when nothing changes, so
 * callers can skip writes and notifications.
 */
export function applyRecordPatch(rec: PhotoRecord, patch: Partial<PhotoRecord>): PhotoRecord {
  const next: PhotoRecord = { ...rec };
  let changed = false;
  const set = <K extends keyof PhotoRecord>(k: K, v: PhotoRecord[K]) => {
    if (!Object.is(next[k], v)) {
      next[k] = v;
      changed = true;
    }
  };
  if (typeof patch.name === 'string' && patch.name.trim()) set('name', patch.name.trim());
  if (typeof patch.folder === 'string') set('folder', normalizeFolder(patch.folder));
  if (typeof patch.type === 'string') set('type', patch.type);
  for (const k of ['size', 'added', 'modified'] as const) {
    const v = patch[k];
    if (typeof v === 'number' && Number.isFinite(v)) set(k, v);
  }
  if (patch.meta && typeof patch.meta === 'object') set('meta', patch.meta);
  if (patch.rating !== undefined) set('rating', clampRating(patch.rating));
  if (isPickFlag(patch.flag)) set('flag', patch.flag);
  if ('label' in patch && (patch.label === null || isColorLabel(patch.label))) set('label', patch.label ?? null);
  if (typeof patch.favorite === 'boolean') set('favorite', patch.favorite);
  if (typeof patch.hasEdits === 'boolean') set('hasEdits', patch.hasEdits);
  if ('editedAt' in patch) {
    const v = patch.editedAt;
    if (v === undefined) {
      if (next.editedAt !== undefined) {
        delete next.editedAt;
        changed = true;
      }
    } else if (typeof v === 'number' && Number.isFinite(v)) set('editedAt', v);
  }
  if (Array.isArray(patch.albumIds)) {
    const ids = uniqueStrings(patch.albumIds);
    if (!sameArray(ids, rec.albumIds)) {
      next.albumIds = ids;
      changed = true;
    }
  }
  return changed ? next : rec;
}

/**
 * Freeze records handed out by the library in dev builds so accidental
 * mutation (which would bypass persistence and notifications) fails loudly.
 */
const FREEZE = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

export function freezeRecord<T extends PhotoRecord | Album>(r: T): T {
  if (!FREEZE) return r;
  if ('albumIds' in r) Object.freeze(r.albumIds);
  return Object.freeze(r);
}
