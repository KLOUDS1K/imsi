/**
 * Library — in-memory index of every PhotoRecord (loaded once at open) backed
 * by the 'photos' / 'files' / 'thumbs' / 'edits' / 'albums' stores.
 *
 * Reads (`all`, `get`, `query`, `facets`, `folders`, `albums`) are synchronous
 * and cheap. Mutations update the index immediately (so the UI reacts at once),
 * persist in one transaction, and roll the index back if the write fails.
 * Subscribers are notified once per microtask no matter how many mutations
 * happened in between.
 *
 * Records and albums are immutable snapshots: every change replaces the object
 * (dev builds freeze them). Never mutate one; call `update()` & co.
 */
import type { KloudDB, LibraryApi, LibraryFacets } from '@/editor/contracts';
import type { Album, ColorLabel, LibraryQuery, PhotoRecord, SerializedEditState } from '@/editor/types';
import { isDefaultParams } from '@/editor/state';
import { AUTOSAVE_SESSION_KEY, getMany, runBatch, type AutosaveRecord, type DBOp } from '@/editor/storage';
import { collectAssetKeys, emptyAssetKeys } from './assets';
import { expandFolders, normalizeFolder, renameFolderPath } from './folders';
import { dedupeKey, importFiles, type ImportDeps, type ImportOptions, type ImportReport } from './import';
import { computeFacets, runQuery } from './query';
import {
  applyRecordPatch,
  clampRating,
  freezeRecord,
  isRawRecord,
  newId,
  sanitizeAlbum,
  sanitizeRecord,
} from './records';
import { foldText } from './text';
import { ThumbnailUrlCache } from './thumbs';

export interface LibraryDeps extends Partial<ImportDeps> {
  /** Clock (tests). */
  now?: () => number;
  /** Id factory for photos and albums (tests). */
  newId?: (kind: 'photo' | 'album') => string;
  /** Thumbnail long edge in px. Default 320. */
  thumbnailSize?: number;
  /** Files imported in parallel. Default 3. */
  importConcurrency?: number;
  /** Live thumbnail object URLs. Default 500. */
  thumbnailCacheSize?: number;
}

const photoPut = (r: PhotoRecord): DBOp => ({ type: 'put', store: 'photos', key: r.id, value: r });
const albumPut = (a: Album): DBOp => ({ type: 'put', store: 'albums', key: a.id, value: a });
const albumCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isEditState(v: unknown): v is SerializedEditState {
  return !!v && typeof v === 'object' && !!(v as SerializedEditState).params && typeof (v as SerializedEditState).params === 'object';
}

export class Library implements LibraryApi {
  readonly db: KloudDB;
  private readonly records = new Map<string, PhotoRecord>();
  private readonly albumMap = new Map<string, Album>();
  private readonly listeners = new Set<() => void>();
  private readonly thumbs: ThumbnailUrlCache;
  private readonly deps: LibraryDeps;
  private readonly clock: () => number;
  private notifyQueued = false;
  private foldersCache: string[] | null = null;
  private facetsCache: LibraryFacets | null = null;
  private albumNamesCache: Map<string, string> | null = null;
  private ioDeps: Promise<ImportDeps> | null = null;
  /** Report of the most recent importFiles() call (unsupported / duplicates / failures). */
  lastImportReport: ImportReport | null = null;

  constructor(db: KloudDB, data: { records?: PhotoRecord[]; albums?: Album[] } = {}, deps: LibraryDeps = {}) {
    this.db = db;
    this.deps = deps;
    this.clock = deps.now ?? Date.now;
    const recs = [...(data.records ?? [])].sort((a, b) => a.added - b.added || (a.id < b.id ? -1 : 1));
    for (const r of recs) this.records.set(r.id, freezeRecord(r));
    for (const a of data.albums ?? []) this.albumMap.set(a.id, freezeRecord(a));
    this.thumbs = new ThumbnailUrlCache((id) => this.getThumbnailBlob(id), deps.thumbnailCacheSize ?? 500);
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  /** Every photo, in import order (a new array; safe to sort). */
  all(): PhotoRecord[] {
    return [...this.records.values()];
  }

  get(id: string): PhotoRecord | undefined {
    return this.records.get(id);
  }

  get size(): number {
    return this.records.size;
  }

  query(q: LibraryQuery): PhotoRecord[] {
    return runQuery([...this.records.values()], q, { albumNames: this.albumNames(), now: this.clock() });
  }

  facets(): LibraryFacets {
    this.facetsCache ??= computeFacets([...this.records.values()]);
    return this.facetsCache;
  }

  folders(): string[] {
    this.foldersCache ??= expandFolders(new Set([...this.records.values()].map((r) => r.folder)));
    return [...this.foldersCache];
  }

  /** Albums sorted by name (natural order). */
  albums(): Album[] {
    return [...this.albumMap.values()].sort((a, b) => albumCollator.compare(a.name, b.name) || a.created - b.created);
  }

  getAlbum(id: string): Album | undefined {
    return this.albumMap.get(id);
  }

  /** Number of photos per album id. */
  albumCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.records.values()) for (const a of r.albumIds) counts.set(a, (counts.get(a) ?? 0) + 1);
    return counts;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Import & binary data                                              */
  /* ---------------------------------------------------------------- */

  /** See import.ts for failure/abort semantics; details land in `lastImportReport`. */
  async importFiles(files: File[], opts: ImportOptions = {}): Promise<PhotoRecord[]> {
    return (await this.importFilesDetailed(files, opts)).imported;
  }

  /** Like importFiles, returning the full report (duplicates, unsupported files, failures, warnings). */
  async importFilesDetailed(files: readonly File[], opts: ImportOptions = {}): Promise<ImportReport> {
    const report = await importFiles(files, opts, {
      deps: () => this.importDeps(),
      existingKeys: () => new Set([...this.records.values()].map((r) => dedupeKey(r.name, r.size, r.meta?.dateTaken))),
      commit: (record, file, thumb) => this.commitImported(record, file, thumb),
      newId: () => this.makeId('photo'),
      now: this.clock,
      thumbnailSize: this.deps.thumbnailSize ?? 320,
      concurrency: this.deps.importConcurrency ?? 3,
    });
    this.lastImportReport = report;
    return report;
  }

  getFile(id: string): Promise<Blob | undefined> {
    return this.db.get<Blob>('files', id);
  }

  getThumbnailBlob(id: string): Promise<Blob | undefined> {
    return this.db.get<Blob>('thumbs', id);
  }

  async getThumbnailUrl(id: string): Promise<string | undefined> {
    if (!this.records.has(id)) return undefined;
    return this.thumbs.get(id);
  }

  /** Replace the stored thumbnail (e.g. rendered from the current edit) and refresh cached URLs. */
  async setThumbnail(id: string, blob: Blob): Promise<void> {
    if (!this.records.has(id)) return;
    await this.db.put('thumbs', id, blob);
    // The photo may have been removed while we were writing: do not resurrect its URL.
    if (this.records.has(id)) this.thumbs.replace(id, blob);
    else await this.db.delete('thumbs', id);
    this.changed();
  }

  /* ---------------------------------------------------------------- */
  /* Record updates                                                    */
  /* ---------------------------------------------------------------- */

  update(id: string, patch: Partial<PhotoRecord>): Promise<void> {
    return this.updateMany([id], patch);
  }

  async updateMany(ids: string[], patch: Partial<PhotoRecord>): Promise<void> {
    const clean: Partial<PhotoRecord> = { ...patch };
    if (clean.albumIds) clean.albumIds = clean.albumIds.filter((a) => this.albumMap.has(a));
    await this.patchRecords(ids, () => clean);
  }

  setRating(ids: string[], rating: number): Promise<void> {
    const value = clampRating(rating);
    return this.patchRecords(ids, () => ({ rating: value }));
  }

  setFlag(ids: string[], flag: PhotoRecord['flag']): Promise<void> {
    return this.patchRecords(ids, () => ({ flag }));
  }

  setLabel(ids: string[], label: ColorLabel | null): Promise<void> {
    return this.patchRecords(ids, () => ({ label }));
  }

  /** Lightroom semantics: if any of them is not a favorite, all become favorites; otherwise all are cleared. */
  toggleFavorite(ids: string[]): Promise<void> {
    const recs = this.existing(ids);
    const value = recs.some((r) => !r.favorite);
    return this.patchRecords(ids, () => ({ favorite: value }));
  }

  /** Move photos to a virtual folder. */
  moveToFolder(ids: string[], folder: string): Promise<void> {
    const f = normalizeFolder(folder);
    return this.patchRecords(ids, () => ({ folder: f }));
  }

  /** Rename a virtual folder (and everything below it). */
  renameFolder(from: string, to: string): Promise<void> {
    const src = normalizeFolder(from);
    const dst = normalizeFolder(to);
    if (!src || !dst || src === dst) return Promise.resolve();
    const ids = [...this.records.values()].filter((r) => renameFolderPath(r.folder, src, dst) !== null).map((r) => r.id);
    return this.patchRecords(ids, (r) => ({ folder: renameFolderPath(r.folder, src, dst) ?? r.folder }));
  }

  /* ---------------------------------------------------------------- */
  /* Edits                                                             */
  /* ---------------------------------------------------------------- */

  async loadEdit(id: string): Promise<SerializedEditState | undefined> {
    const v = await this.db.get<unknown>('edits', id);
    return isEditState(v) ? v : undefined;
  }

  /**
   * Persist an edit and keep `hasEdits` (params differ from the photo's
   * defaults) and `editedAt` in sync, in one transaction. Ignored for photos
   * that no longer exist (a late autosave after removal).
   */
  async saveEdit(id: string, state: SerializedEditState): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    let hasEdits = true;
    try {
      hasEdits = !isDefaultParams(state.params, isRawRecord(rec));
    } catch {
      // Malformed params: count as edited rather than hide the photo from "edited" filters.
    }
    const at = typeof state.updated === 'number' && Number.isFinite(state.updated) ? state.updated : this.clock();
    const next = applyRecordPatch(rec, { hasEdits, editedAt: hasEdits ? at : undefined });
    const editOp: DBOp = { type: 'put', store: 'edits', key: id, value: state };
    if (next === rec) {
      await runBatch(this.db, [editOp]);
      return;
    }
    await this.commitRecords([next], [editOp]);
  }

  /* ---------------------------------------------------------------- */
  /* Removal                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Remove photos with their original, thumbnail and edit, plus removal
   * patches / AI mask bitmaps that no remaining photo references, and the
   * crash-recovery record when it belongs to one of them.
   */
  async remove(ids: string[]): Promise<void> {
    const victims = this.existing(ids);
    if (victims.length === 0) return;
    const victimIds = new Set(victims.map((r) => r.id));

    // Update the index first so the grid drops them immediately.
    for (const r of victims) this.records.delete(r.id);
    const coverFixes = this.fixAlbumCovers(victimIds);
    this.changed();

    try {
      const ops: DBOp[] = [];
      for (const id of victimIds) {
        for (const store of ['photos', 'files', 'thumbs', 'edits'] as const) ops.push({ type: 'delete', store, key: id });
      }
      ops.push(...coverFixes.map((f) => albumPut(f.next)));

      // Binary assets referenced only by the removed photos.
      const victimEdits = await getMany<SerializedEditState>(this.db, 'edits', [...victimIds]);
      const orphaned = emptyAssetKeys();
      for (const e of victimEdits) collectAssetKeys(e, orphaned);
      if (orphaned.patches.size + orphaned.bitmaps.size > 0) {
        const others = [...this.records.values()].filter((r) => r.hasEdits).map((r) => r.id);
        const stillUsed = emptyAssetKeys();
        for (const e of await getMany<SerializedEditState>(this.db, 'edits', others)) collectAssetKeys(e, stillUsed);
        for (const k of orphaned.patches) if (!stillUsed.patches.has(k)) ops.push({ type: 'delete', store: 'patches', key: k });
        for (const k of orphaned.bitmaps) if (!stillUsed.bitmaps.has(k)) ops.push({ type: 'delete', store: 'maskBitmaps', key: k });
      }

      const session = await this.db.get<AutosaveRecord>('autosave', AUTOSAVE_SESSION_KEY);
      if (session && victimIds.has(session.photoId)) ops.push({ type: 'delete', store: 'autosave', key: AUTOSAVE_SESSION_KEY });

      await runBatch(this.db, ops);
    } catch (err) {
      // Nothing was deleted (the batch is atomic): put the photos and album covers back.
      for (const r of victims) if (!this.records.has(r.id)) this.records.set(r.id, r);
      for (const { prev, next } of coverFixes) if (this.albumMap.get(next.id) === next) this.albumMap.set(prev.id, prev);
      this.changed();
      throw err;
    }
    for (const id of victimIds) this.thumbs.invalidate(id);
  }

  /* ---------------------------------------------------------------- */
  /* Albums                                                            */
  /* ---------------------------------------------------------------- */

  async createAlbum(name: string): Promise<Album> {
    const album: Album = freezeRecord({ id: this.makeId('album'), name: this.uniqueAlbumName(name), created: this.clock() });
    this.albumMap.set(album.id, album);
    this.changed();
    try {
      await runBatch(this.db, [albumPut(album)]);
    } catch (err) {
      this.albumMap.delete(album.id);
      this.changed();
      throw err;
    }
    return album;
  }

  async renameAlbum(id: string, name: string): Promise<void> {
    const album = this.requireAlbum(id);
    const next = freezeRecord({ ...album, name: this.uniqueAlbumName(name, id) });
    if (next.name === album.name) return;
    await this.commitAlbums([next]);
  }

  /** Delete the album; its photos stay in the library. */
  async deleteAlbum(id: string): Promise<void> {
    const album = this.albumMap.get(id);
    if (!album) return;
    const members = [...this.records.values()].filter((r) => r.albumIds.includes(id));
    const prevRecords = members.map((r) => [r.id, r] as const);
    this.albumMap.delete(id);
    const nextRecords = members.map((r) => applyRecordPatch(r, { albumIds: r.albumIds.filter((a) => a !== id) }));
    for (const r of nextRecords) this.records.set(r.id, freezeRecord(r));
    this.changed();
    try {
      await runBatch(this.db, [{ type: 'delete', store: 'albums', key: id }, ...nextRecords.map(photoPut)]);
    } catch (err) {
      this.albumMap.set(id, album);
      for (const [rid, r] of prevRecords) if (this.records.has(rid)) this.records.set(rid, r);
      this.changed();
      throw err;
    }
  }

  async addToAlbum(photoIds: string[], albumId: string): Promise<void> {
    const album = this.requireAlbum(albumId);
    const recs = this.existing(photoIds).filter((r) => !r.albumIds.includes(albumId));
    if (recs.length === 0) return;
    const next = recs.map((r) => applyRecordPatch(r, { albumIds: [...r.albumIds, albumId] }));
    const albums = album.coverId && this.records.get(album.coverId)?.albumIds.includes(albumId) ? [] : [{ ...album, coverId: recs[0].id }];
    await this.commitRecords(next, [], albums);
  }

  async removeFromAlbum(photoIds: string[], albumId: string): Promise<void> {
    const album = this.requireAlbum(albumId);
    const ids = new Set(photoIds);
    const recs = this.existing(photoIds).filter((r) => r.albumIds.includes(albumId));
    if (recs.length === 0) return;
    const next = recs.map((r) => applyRecordPatch(r, { albumIds: r.albumIds.filter((a) => a !== albumId) }));
    let albums: Album[] = [];
    if (album.coverId && ids.has(album.coverId)) {
      const replacement = [...this.records.values()].find((r) => !ids.has(r.id) && r.albumIds.includes(albumId));
      const updated: Album = { ...album };
      if (replacement) updated.coverId = replacement.id;
      else delete updated.coverId;
      albums = [updated];
    }
    await this.commitRecords(next, [], albums);
  }

  /** Choose the album's cover photo (must be a member). */
  async setAlbumCover(albumId: string, photoId: string): Promise<void> {
    const album = this.requireAlbum(albumId);
    if (!this.records.get(photoId)?.albumIds.includes(albumId) || album.coverId === photoId) return;
    await this.commitAlbums([{ ...album, coverId: photoId }]);
  }

  /** Revoke thumbnail URLs and drop listeners (the database stays open). */
  dispose(): void {
    this.thumbs.clear();
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private existing(ids: readonly string[]): PhotoRecord[] {
    const seen = new Set<string>();
    const out: PhotoRecord[] = [];
    for (const id of ids) {
      const r = this.records.get(id);
      if (r && !seen.has(id)) {
        seen.add(id);
        out.push(r);
      }
    }
    return out;
  }

  private requireAlbum(id: string): Album {
    const a = this.albumMap.get(id);
    if (!a) throw new Error(`Album not found: ${id}`);
    return a;
  }

  private uniqueAlbumName(name: string, selfId?: string): string {
    const base = name.trim().replace(/\s+/g, ' ');
    if (!base) throw new Error('Album name must not be empty');
    const taken = new Set([...this.albumMap.values()].filter((a) => a.id !== selfId).map((a) => foldText(a.name)));
    let candidate = base;
    for (let n = 2; taken.has(foldText(candidate)); n++) candidate = `${base} ${n}`;
    return candidate;
  }

  private makeId(kind: 'photo' | 'album'): string {
    return this.deps.newId ? this.deps.newId(kind) : newId(kind === 'photo' ? 'p' : 'a');
  }

  private importDeps(): Promise<ImportDeps> {
    const d = this.deps;
    if (d.isSupportedFile && d.readMetadata && d.makeThumbnail) {
      return Promise.resolve({ isSupportedFile: d.isSupportedFile, readMetadata: d.readMetadata, makeThumbnail: d.makeThumbnail });
    }
    // Loaded on first import only: keeps io (and its decoders) out of the startup path.
    this.ioDeps ??= import('@/editor/io').then(
      (io) => ({
        isSupportedFile: d.isSupportedFile ?? io.isSupportedFile,
        readMetadata: d.readMetadata ?? io.readMetadata,
        makeThumbnail: d.makeThumbnail ?? io.makeThumbnail,
      }),
      (err: unknown) => {
        this.ioDeps = null;
        throw err;
      },
    );
    return this.ioDeps;
  }

  private async commitImported(record: PhotoRecord, file: Blob, thumb: Blob | null): Promise<void> {
    const ops: DBOp[] = [{ type: 'put', store: 'files', key: record.id, value: file }];
    if (thumb) ops.push({ type: 'put', store: 'thumbs', key: record.id, value: thumb });
    ops.push(photoPut(record));
    await runBatch(this.db, ops);
    this.records.set(record.id, freezeRecord(record));
    this.changed();
  }

  /** Apply a per-record patch to existing ids; unchanged records are skipped entirely. */
  private async patchRecords(ids: readonly string[], patchFor: (r: PhotoRecord) => Partial<PhotoRecord>): Promise<void> {
    const next: PhotoRecord[] = [];
    for (const r of this.existing(ids)) {
      const n = applyRecordPatch(r, patchFor(r));
      if (n !== r) next.push(n);
    }
    if (next.length > 0) await this.commitRecords(next);
  }

  /**
   * Optimistically swap records (and albums) in the index, persist them plus
   * `extraOps` in one transaction, and roll back on failure. The rollback only
   * touches entries that still hold the values set here, so a later
   * successful mutation is never undone.
   */
  private async commitRecords(next: PhotoRecord[], extraOps: DBOp[] = [], albums: Album[] = []): Promise<void> {
    const frozen = next.map((r) => freezeRecord(r));
    const frozenAlbums = albums.map((a) => freezeRecord(a));
    const prev = frozen.map((r) => this.records.get(r.id));
    const prevAlbums = frozenAlbums.map((a) => this.albumMap.get(a.id));
    for (const r of frozen) this.records.set(r.id, r);
    for (const a of frozenAlbums) this.albumMap.set(a.id, a);
    this.changed();
    try {
      await runBatch(this.db, [...frozen.map(photoPut), ...frozenAlbums.map(albumPut), ...extraOps]);
    } catch (err) {
      frozen.forEach((r, i) => {
        const p = prev[i];
        if (this.records.get(r.id) === r && p) this.records.set(r.id, p);
      });
      frozenAlbums.forEach((a, i) => {
        const p = prevAlbums[i];
        if (this.albumMap.get(a.id) === a && p) this.albumMap.set(a.id, p);
      });
      this.changed();
      throw err;
    }
  }

  private commitAlbums(albums: Album[]): Promise<void> {
    return this.commitRecords([], [], albums);
  }

  /** Albums whose cover is being removed get the next member (or none); applied now, returned for persisting/rollback. */
  private fixAlbumCovers(removed: ReadonlySet<string>): { prev: Album; next: Album }[] {
    const fixes: { prev: Album; next: Album }[] = [];
    for (const album of this.albumMap.values()) {
      if (!album.coverId || !removed.has(album.coverId)) continue;
      const replacement = [...this.records.values()].find((r) => r.albumIds.includes(album.id));
      const updated: Album = { ...album };
      if (replacement) updated.coverId = replacement.id;
      else delete updated.coverId;
      fixes.push({ prev: album, next: freezeRecord(updated) });
    }
    for (const f of fixes) this.albumMap.set(f.next.id, f.next);
    return fixes;
  }

  private albumNames(): Map<string, string> {
    if (!this.albumNamesCache) {
      this.albumNamesCache = new Map([...this.albumMap.values()].map((a) => [a.id, foldText(a.name)]));
    }
    return this.albumNamesCache;
  }

  /** Invalidate derived caches and queue one notification for this tick. */
  private changed(): void {
    this.foldersCache = null;
    this.facetsCache = null;
    this.albumNamesCache = null;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const cb of [...this.listeners]) {
        try {
          cb();
        } catch (err) {
          console.error('[kloud/library] subscriber threw', err);
        }
      }
    });
  }
}

/**
 * Load the library index from `db`. Io functions default to `@/editor/io`
 * (loaded lazily on the first import); pass them in `deps` to stub them.
 */
export async function openLibrary(db: KloudDB, deps: LibraryDeps = {}): Promise<Library> {
  const [rawRecords, rawAlbums] = await Promise.all([db.getAll<unknown>('photos'), db.getAll<unknown>('albums')]);
  const albums = rawAlbums.map(sanitizeAlbum).filter((a): a is Album => a !== null);
  const albumIds = new Set(albums.map((a) => a.id));
  const records: PhotoRecord[] = [];
  for (const raw of rawRecords) {
    const r = sanitizeRecord(raw);
    if (!r) continue;
    // Drop references to albums that no longer exist (e.g. an interrupted delete in an old build).
    if (r.albumIds.some((a) => !albumIds.has(a))) r.albumIds = r.albumIds.filter((a) => albumIds.has(a));
    records.push(r);
  }
  return new Library(db, { records, albums }, deps);
}
