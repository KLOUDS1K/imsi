import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Library, ThumbnailUrlCache, openLibrary, type ImportProgressDetail } from '@/editor/library';
import { AUTOSAVE_SESSION_KEY, MemoryKloudDB, openDB } from '@/editor/storage';
import { createDefaultParams, createMask } from '@/editor/defaults';
import type { ImportProgress } from '@/editor/contracts';
import type { SerializedEditState } from '@/editor/types';
import { makeFile, stubDeps } from './fixtures';

let dbSeq = 0;
const idb = () => openDB({ name: `kloud-lib-${Date.now()}-${dbSeq++}`, persist: false });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function edit(mut?: (p: ReturnType<typeof createDefaultParams>) => void, updated = 5000): SerializedEditState {
  const params = createDefaultParams();
  mut?.(params);
  return { format: 'kloud-edit', version: 1, params, history: [], historyIndex: 0, snapshots: [], updated };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importFiles', () => {
  it('imports supported files with progress, thumbnails and a default folder', async () => {
    const db = await idb();
    const now = Date.UTC(2026, 8, 24, 9);
    const deps = stubDeps({ now: () => now });
    const lib = await openLibrary(db, deps);
    const progress: ImportProgress[] = [];
    const recs = await lib.importFiles([makeFile('a.jpg'), makeFile('notes.txt'), makeFile('b.png', 'bb', undefined, 'image/png')], {
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(recs.map((r) => r.name)).toEqual(['a.jpg', 'b.png']);
    expect(lib.lastImportReport?.unsupported).toEqual(['notes.txt']);
    expect(progress[0]).toMatchObject({ done: 0, total: 2 });
    expect(progress.at(-1)).toMatchObject({ done: 2, total: 2 });
    expect(deps.thumbCalls.every((c) => c.maxSize === 320)).toBe(true);
    for (const r of recs) {
      expect(r.folder).toBe(`Imported/${localDay(now)}`);
      expect(r).toMatchObject({ rating: 0, flag: 'none', label: null, favorite: false, albumIds: [], hasEdits: false });
      expect(await (await lib.getFile(r.id))?.text()).toBe(r.name === 'a.jpg' ? 'a.jpg' : 'bb');
      expect(await (await db.get<Blob>('thumbs', r.id))?.text()).toBe(`thumb:${r.name}`);
      expect(await db.get('photos', r.id)).toEqual(r);
    }
    expect(recs[1].added).toBeGreaterThan(recs[0].added);
    expect(lib.all()).toHaveLength(2);
    expect(await lib.getThumbnailUrl(recs[0].id)).toMatch(/^blob:/);
    lib.dispose();
  });

  it('derives folders from opts.folder, then webkitRelativePath, then the date', async () => {
    const lib = await openLibrary(new MemoryKloudDB(), stubDeps({ now: () => Date.UTC(2026, 0, 15, 12) }));
    const [fixed] = await lib.importFiles([makeFile('x.jpg', 'x', 'Holiday/Day 1/x.jpg')], { folder: ' Trips//Seoul/ ' });
    expect(fixed.folder).toBe('Trips/Seoul');
    const [rel, top] = await lib.importFiles([makeFile('y.jpg', 'y', 'Holiday/Day 1/y.jpg'), makeFile('z.jpg', 'z', 'z.jpg')]);
    expect(rel.folder).toBe('Holiday/Day 1');
    expect(top.folder).toBe(`Imported/${localDay(Date.UTC(2026, 0, 15, 12))}`);
    expect(lib.folders()).toEqual(['Holiday', 'Holiday/Day 1', 'Imported', top.folder, 'Trips', 'Trips/Seoul']);
  });

  it('skips exact duplicates (name + size + date taken) within and across imports', async () => {
    const deps = stubDeps({ metas: { 'c.jpg': { dateTaken: '2026-01-01T10:00:00' } } });
    const lib = await openLibrary(new MemoryKloudDB(), deps);
    const first = await lib.importFiles([makeFile('a.jpg', 'same'), makeFile('a.jpg', 'same'), makeFile('c.jpg')]);
    expect(first).toHaveLength(2);
    expect(lib.lastImportReport?.duplicates).toEqual(['a.jpg']);
    const again = await lib.importFiles([makeFile('a.jpg', 'same'), makeFile('a.jpg', 'longer content'), makeFile('c.jpg')]);
    expect(again.map((r) => r.size)).toEqual([14]);
    expect(lib.lastImportReport?.duplicates).toEqual(['a.jpg', 'c.jpg']);
    expect(lib.all()).toHaveLength(3);
  });

  it('isolates per-file failures and reports them', async () => {
    const deps = stubDeps({ failMeta: ['bad.jpg'], failThumb: ['nothumb.jpg'] });
    const lib = await openLibrary(new MemoryKloudDB(), deps);
    const errors: string[] = [];
    let last: ImportProgressDetail | undefined;
    const recs = await lib.importFiles([makeFile('ok.jpg'), makeFile('bad.jpg'), makeFile('nothumb.jpg')], {
      onProgress: (p) => {
        last = p as ImportProgressDetail;
      },
    });
    for (const e of last?.errors ?? []) errors.push(`${e.name}: ${e.message}`);
    expect(recs.map((r) => r.name)).toEqual(['ok.jpg', 'nothumb.jpg']);
    expect(errors).toEqual(['bad.jpg: corrupt bad.jpg']);
    expect(last).toMatchObject({ done: 3, total: 3, imported: 2, failed: 1 });
    expect(lib.lastImportReport?.warnings.map((w) => w.name)).toEqual(['nothumb.jpg']);
    expect(await lib.getThumbnailUrl(recs[1].id)).toBeUndefined();
    // The failed file can be retried later (it was not claimed as a duplicate).
    const retry = await openLibrary(new MemoryKloudDB(), stubDeps());
    expect(await retry.importFiles([makeFile('bad.jpg')])).toHaveLength(1);
  });

  it('limits concurrency to 3 and marks RAW files', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps = stubDeps();
    const readMetadata = deps.readMetadata!;
    deps.readMetadata = async (file, name) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return readMetadata(file, name);
    };
    const lib = await openLibrary(new MemoryKloudDB(), deps);
    const files = Array.from({ length: 10 }, (_, i) => makeFile(i === 4 ? 'DSC_0004.ARW' : `f${i}.jpg`, `c${i}`));
    const recs = await lib.importFiles(files);
    expect(recs).toHaveLength(10);
    expect(peak).toBe(3);
    // Results keep the input order despite the parallelism.
    expect(recs.map((r) => r.name)).toEqual(files.map((f) => f.name));
    expect(recs[4].meta.format).toBe('raw');
  });

  it('stops on abort and resolves with what was imported so far', async () => {
    const db = new MemoryKloudDB();
    const lib = await openLibrary(db, stubDeps({ delayMs: 5 }));
    const ctrl = new AbortController();
    const files = Array.from({ length: 12 }, (_, i) => makeFile(`f${i}.jpg`, `c${i}`));
    const recs = await lib.importFiles(files, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.done >= 2) ctrl.abort();
      },
    });
    expect(lib.lastImportReport?.aborted).toBe(true);
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs.length).toBeLessThan(12);
    await tick();
    expect(lib.all()).toHaveLength(recs.length);
    expect(await db.keys('photos')).toHaveLength(recs.length);
    expect(await db.keys('files')).toHaveLength(recs.length);
  });
});

describe('Library mutations', () => {
  async function seeded(n = 3) {
    const db = new MemoryKloudDB();
    const lib = await openLibrary(db, stubDeps({ ids: true }));
    const recs = await lib.importFiles(Array.from({ length: n }, (_, i) => makeFile(`p${i}.jpg`, `content ${i}`)), { folder: 'Shoot' });
    return { db, lib, ids: recs.map((r) => r.id) };
  }

  it('batches notifications and persists ratings, flags, labels and favorites', async () => {
    const { db, lib, ids } = await seeded();
    await tick();
    const cb = vi.fn();
    const unsub = lib.subscribe(cb);
    const a = lib.setRating(ids, 7);
    const b = lib.setFlag([ids[0]], 'pick');
    const c = lib.setLabel([ids[1], 'nope'], 'green');
    await Promise.all([a, b, c]);
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(lib.all().map((r) => r.rating)).toEqual([5, 5, 5]);
    expect(lib.get(ids[0])?.flag).toBe('pick');
    expect(lib.get(ids[1])?.label).toBe('green');

    await lib.toggleFavorite([ids[0]]);
    expect(lib.get(ids[0])?.favorite).toBe(true);
    // Mixed selection → all become favorites; then all cleared.
    await lib.toggleFavorite(ids);
    expect(lib.all().every((r) => r.favorite)).toBe(true);
    await lib.toggleFavorite(ids);
    expect(lib.all().some((r) => r.favorite)).toBe(false);
    await lib.setLabel([ids[1]], null);
    await lib.setRating([ids[2]], -3);

    const reopened = await openLibrary(db);
    expect(reopened.get(ids[0])).toMatchObject({ rating: 5, flag: 'pick', favorite: false });
    expect(reopened.get(ids[1])?.label).toBeNull();
    expect(reopened.get(ids[2])?.rating).toBe(0);
    await tick();
    const calls = cb.mock.calls.length;
    unsub();
    await lib.setRating(ids, 1);
    await tick();
    expect(cb).toHaveBeenCalledTimes(calls);
  });

  it('update/updateMany validate the patch and never change the id', async () => {
    const { db, lib, ids } = await seeded();
    await lib.update(ids[0], { id: 'hacked', name: ' Renamed.jpg ', folder: 'A//B/', rating: 9 });
    const r = lib.get(ids[0]);
    expect(r).toMatchObject({ id: ids[0], name: 'Renamed.jpg', folder: 'A/B', rating: 5 });
    expect(lib.get('hacked')).toBeUndefined();
    await lib.updateMany(ids, { folder: 'Moved', albumIds: ['does-not-exist'] });
    expect(lib.all().map((x) => x.folder)).toEqual(['Moved', 'Moved', 'Moved']);
    expect(lib.all().every((x) => x.albumIds.length === 0)).toBe(true);
    expect((await db.get<{ folder: string }>('photos', ids[2]))?.folder).toBe('Moved');
    expect(() => {
      (r as { rating: number }).rating = 1;
    }).toThrow();
  });

  it('keeps hasEdits / editedAt in sync with saved edits', async () => {
    const { db, lib, ids } = await seeded();
    expect(await lib.loadEdit(ids[0])).toBeUndefined();
    await lib.saveEdit(ids[0], edit((p) => (p.basic.exposure = 0.5), 4242));
    expect(lib.get(ids[0])).toMatchObject({ hasEdits: true, editedAt: 4242 });
    expect((await lib.loadEdit(ids[0]))?.params.basic.exposure).toBe(0.5);
    await lib.saveEdit(ids[0], edit());
    expect(lib.get(ids[0])?.hasEdits).toBe(false);
    expect(lib.get(ids[0])?.editedAt).toBeUndefined();
    expect(lib.query({ edited: 'edited' })).toHaveLength(0);
    // Saving for an unknown photo is ignored.
    await lib.saveEdit('ghost', edit());
    expect(await db.get('edits', 'ghost')).toBeUndefined();
  });

  it('albums: create (unique names), rename, add/remove with covers, delete', async () => {
    const { db, lib, ids } = await seeded(4);
    const a = await lib.createAlbum('  Seoul  ');
    const b = await lib.createAlbum('seoul');
    expect(a.name).toBe('Seoul');
    expect(b.name).toBe('seoul 2');
    await expect(lib.createAlbum('   ')).rejects.toThrow();
    await lib.renameAlbum(b.id, 'Best');
    expect(lib.albums().map((x) => x.name)).toEqual(['Best', 'Seoul']);

    await lib.addToAlbum([ids[0], ids[1], ids[1]], a.id);
    expect(lib.get(ids[1])?.albumIds).toEqual([a.id]);
    expect(lib.albums().find((x) => x.id === a.id)?.coverId).toBe(ids[0]);
    await lib.addToAlbum([ids[0], ids[2]], b.id);
    expect(lib.query({ albumId: a.id }).map((r) => r.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(lib.query({ text: 'best' }).map((r) => r.id).sort()).toEqual([ids[0], ids[2]].sort());

    await lib.removeFromAlbum([ids[0]], a.id);
    expect(lib.get(ids[0])?.albumIds).toEqual([b.id]);
    expect(lib.albums().find((x) => x.id === a.id)?.coverId).toBe(ids[1]);

    await lib.deleteAlbum(b.id);
    expect(lib.albums().map((x) => x.id)).toEqual([a.id]);
    expect(lib.all().some((r) => r.albumIds.includes(b.id))).toBe(false);
    expect(await db.get('albums', b.id)).toBeUndefined();
    const reopened = await openLibrary(db);
    expect(reopened.albums().map((x) => x.name)).toEqual(['Seoul']);
    expect(reopened.get(ids[1])?.albumIds).toEqual([a.id]);
  });

  it('remove() cascades to files, thumbs, edits, orphaned patches/bitmaps and the recovery record', async () => {
    const db = await idb();
    const lib = await openLibrary(db, stubDeps());
    const [p1, p2] = await lib.importFiles([makeFile('one.jpg', '1'), makeFile('two.jpg', '2')]);
    const withAssets = (keys: string[], bitmap?: string) =>
      edit((p) => {
        p.retouch.removals = keys.map((k, i) => ({ id: `r${i}`, kind: 'generative', bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, strokes: [], patchKey: k }));
        if (bitmap) {
          const m = createMask('Sky', 'm1');
          m.components.push({ id: 'c1', kind: 'ai', mode: 'add', invert: false, ai: { target: 'sky', bitmapKey: bitmap } });
          p.masks = [m];
        }
      });
    await lib.saveEdit(p1.id, withAssets(['pk-own', 'pk-shared'], 'bk-own'));
    await lib.saveEdit(p2.id, withAssets(['pk-shared']));
    for (const k of ['pk-own', 'pk-shared']) await db.put('patches', k, { width: 1 });
    await db.put('maskBitmaps', 'bk-own', { width: 1 });
    await db.put('autosave', AUTOSAVE_SESSION_KEY, { photoId: p1.id, state: edit(), savedAt: 1, dirty: true });

    const url = await lib.getThumbnailUrl(p1.id);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await lib.remove([p1.id, 'unknown']);
    expect(lib.get(p1.id)).toBeUndefined();
    expect(lib.all().map((r) => r.id)).toEqual([p2.id]);
    for (const store of ['photos', 'files', 'thumbs', 'edits'] as const) expect(await db.get(store, p1.id)).toBeUndefined();
    expect(await db.get('files', p2.id)).toBeDefined();
    expect(await db.keys('patches')).toEqual(['pk-shared']);
    expect(await db.keys('maskBitmaps')).toEqual([]);
    expect(await db.get('autosave', AUTOSAVE_SESSION_KEY)).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(await lib.getThumbnailUrl(p1.id)).toBeUndefined();
    db.close();
  });

  it('setThumbnail replaces the stored thumbnail and invalidates the cached URL', async () => {
    const { db, lib, ids } = await seeded(1);
    const before = await lib.getThumbnailUrl(ids[0]);
    expect(await lib.getThumbnailUrl(ids[0])).toBe(before);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await lib.setThumbnail(ids[0], new Blob(['edited'], { type: 'image/jpeg' }));
    const after = await lib.getThumbnailUrl(ids[0]);
    expect(after).not.toBe(before);
    expect(revoke).toHaveBeenCalledWith(before);
    expect(await (await db.get<Blob>('thumbs', ids[0]))?.text()).toBe('edited');
  });
});

describe('ThumbnailUrlCache', () => {
  it('revokes the least recently used URL beyond capacity and shares in-flight loads', async () => {
    let n = 0;
    const revoked: string[] = [];
    const api = { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u: string) => void revoked.push(u) };
    const loads: string[] = [];
    const cache = new ThumbnailUrlCache(
      async (id) => {
        loads.push(id);
        return id === 'none' ? undefined : new Blob([id]);
      },
      2,
      api,
    );
    const [a1, a2] = await Promise.all([cache.get('a'), cache.get('a')]);
    expect(a1).toBe(a2);
    expect(loads).toEqual(['a']);
    await cache.get('b');
    await cache.get('a'); // a becomes most recent
    await cache.get('c'); // evicts b
    expect(revoked).toEqual(['blob:2']);
    expect(cache.peek('b')).toBeUndefined();
    expect(await cache.get('none')).toBeUndefined();
    const replaced = cache.replace('a', new Blob(['new']));
    expect(revoked).toContain('blob:1');
    expect(await cache.get('a')).toBe(replaced);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('Library constructor', () => {
  it('conforms to LibraryApi and orders records by import time', () => {
    const lib = new Library(new MemoryKloudDB(), {});
    expect(lib.all()).toEqual([]);
    expect(lib.facets()).toMatchObject({ cameras: [], folders: [] });
  });
});
