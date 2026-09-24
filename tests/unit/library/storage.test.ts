import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_SESSION_KEY,
  AutosaveManager,
  MemoryKloudDB,
  STORE_NAMES,
  backendOf,
  deleteDatabase,
  getMany,
  loadSetting,
  openDB,
  runBatch,
  saveSetting,
  storageModule,
} from '@/editor/storage';
import type { KloudDB } from '@/editor/contracts';
import type { SerializedEditState } from '@/editor/types';
import { createDefaultParams } from '@/editor/defaults';

let dbCounter = 0;
const uniqueName = () => `kloud-test-${Date.now()}-${dbCounter++}`;

function editState(exposure: number, updated = 1): SerializedEditState {
  const params = createDefaultParams();
  params.basic.exposure = exposure;
  return { format: 'kloud-edit', version: 1, params, history: [], historyIndex: 0, snapshots: [], updated };
}

describe('openDB (IndexedDB backend)', () => {
  it('conforms to the contract object', () => {
    expect(typeof storageModule.openDB).toBe('function');
    expect(typeof storageModule.AutosaveManager).toBe('function');
  });

  it('creates every store and supports CRUD on each', async () => {
    const db = await openDB({ name: uniqueName(), persist: false });
    expect(backendOf(db)).toBe('indexeddb');
    for (const store of STORE_NAMES) {
      await db.put(store, 'b', { n: 2 });
      await db.put(store, 'a', { n: 1 });
      expect(await db.get(store, 'a')).toEqual({ n: 1 });
      expect(await db.get(store, 'missing')).toBeUndefined();
      expect(await db.keys(store)).toEqual(['a', 'b']);
      expect(await db.getAll(store)).toEqual([{ n: 1 }, { n: 2 }]);
      await db.delete(store, 'a');
      expect(await db.keys(store)).toEqual(['b']);
      await db.clear(store);
      expect(await db.getAll(store)).toEqual([]);
    }
    db.close();
  });

  it('stores Blobs and typed arrays', async () => {
    const db = await openDB({ name: uniqueName(), persist: false });
    await db.put('files', 'p1', new Blob(['hello'], { type: 'image/jpeg' }));
    await db.put('patches', 'k', { width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    const blob = await db.get<Blob>('files', 'p1');
    expect(blob?.size).toBe(5);
    expect(await blob?.text()).toBe('hello');
    const patch = await db.get<{ data: Uint8Array }>('patches', 'k');
    expect(Array.from(patch?.data ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    db.close();
  });

  it('persists across connections', async () => {
    const name = uniqueName();
    const a = await openDB({ name, persist: false });
    await a.put('settings', 'theme', 'dark');
    a.close();
    const b = await openDB({ name, persist: false });
    expect(await b.get('settings', 'theme')).toBe('dark');
    b.close();
    expect(await deleteDatabase(name)).toBe(true);
  });

  it('reconnects lazily after close()', async () => {
    const db = await openDB({ name: uniqueName(), persist: false });
    await db.put('settings', 'x', 1);
    db.close();
    expect(await db.get('settings', 'x')).toBe(1);
    db.close();
  });

  it('batch() is atomic across stores and getMany() reads in one go', async () => {
    const db = await openDB({ name: uniqueName(), persist: false });
    await runBatch(db, [
      { type: 'put', store: 'photos', key: 'p1', value: { id: 'p1' } },
      { type: 'put', store: 'thumbs', key: 'p1', value: new Blob(['t']) },
      { type: 'put', store: 'edits', key: 'p1', value: { e: 1 } },
    ]);
    expect(await getMany(db, 'photos', ['p1', 'nope'])).toEqual([{ id: 'p1' }, undefined]);
    // A value that cannot be cloned aborts the whole batch: the delete must not happen either.
    await expect(
      runBatch(db, [
        { type: 'delete', store: 'photos', key: 'p1' },
        { type: 'put', store: 'edits', key: 'p2', value: { fn: () => 1 } },
      ]),
    ).rejects.toBeTruthy();
    expect(await db.get('photos', 'p1')).toEqual({ id: 'p1' });
    expect(await db.get('edits', 'p2')).toBeUndefined();
    db.close();
  });

  it('estimate() returns numbers', async () => {
    const db = await openDB({ name: uniqueName(), persist: false });
    const e = await db.estimate();
    expect(typeof e.usage).toBe('number');
    expect(typeof e.quota).toBe('number');
    db.close();
  });
});

describe('openDB fallback', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('falls back to memory when IndexedDB is missing or throws, logging at most once', async () => {
    const a = await openDB({ factory: null });
    expect(backendOf(a)).toBe('memory');
    const throwing = {
      open() {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;
    const b = await openDB({ factory: throwing });
    expect(backendOf(b)).toBe('memory');
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    await b.put('photos', 'x', { ok: true });
    expect(await b.get('photos', 'x')).toEqual({ ok: true });
  });

  it('falls back when open hangs', async () => {
    const hanging = { open: () => ({}) } as unknown as IDBFactory;
    const db = await openDB({ factory: hanging, timeoutMs: 20 });
    expect(backendOf(db)).toBe('memory');
  });
});

describe('MemoryKloudDB', () => {
  it('supports CRUD on every store and clones values', async () => {
    const db = new MemoryKloudDB();
    for (const store of STORE_NAMES) {
      const v = { list: [1, 2] };
      await db.put(store, 'k2', v);
      await db.put(store, 'k1', { list: [0] });
      v.list.push(3);
      const got = await db.get<{ list: number[] }>(store, 'k2');
      expect(got).toEqual({ list: [1, 2] });
      got!.list.push(9);
      expect(await db.get(store, 'k2')).toEqual({ list: [1, 2] });
      expect(await db.keys(store)).toEqual(['k1', 'k2']);
      await db.delete(store, 'k1');
      expect(await db.getAll(store)).toEqual([{ list: [1, 2] }]);
      await db.clear(store);
      expect(await db.keys(store)).toEqual([]);
    }
  });

  it('keeps Blob identity and counts usage', async () => {
    const db = new MemoryKloudDB();
    const blob = new Blob(['12345']);
    await db.put('files', 'a', blob);
    expect(await db.get('files', 'a')).toBe(blob);
    expect((await db.estimate()).usage).toBeGreaterThanOrEqual(5);
  });

  it('batch() is all-or-nothing', async () => {
    const db = new MemoryKloudDB();
    await db.put('photos', 'a', 1);
    await expect(
      db.batch([
        { type: 'delete', store: 'photos', key: 'a' },
        { type: 'put', store: 'photos', key: 'b', value: { fn: () => 1 } },
      ]),
    ).rejects.toBeTruthy();
    expect(await db.get('photos', 'a')).toBe(1);
  });
});

describe('settings', () => {
  it('loads fallbacks, stored values and merges new object keys', async () => {
    const db = new MemoryKloudDB();
    expect(await loadSetting(db, 'theme', 'light')).toBe('light');
    await saveSetting(db, 'theme', 'dark');
    expect(await loadSetting(db, 'theme', 'light')).toBe('dark');
    // Wrong type (stale value from an old build) → fallback.
    await saveSetting(db, 'zoom', 'big');
    expect(await loadSetting(db, 'zoom', 1)).toBe(1);
    await saveSetting(db, 'panel', { open: false });
    expect(await loadSetting(db, 'panel', { open: true, width: 300 })).toEqual({ open: false, width: 300 });
    await saveSetting(db, 'recent', ['a']);
    expect(await loadSetting<string[]>(db, 'recent', [])).toEqual(['a']);
  });
});

describe('AutosaveManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function countingDb(): { db: MemoryKloudDB; puts: { store: string; key: string }[] } {
    const db = new MemoryKloudDB();
    const puts: { store: string; key: string }[] = [];
    const orig = db.put.bind(db);
    db.put = async <T>(store: Parameters<KloudDB['put']>[0], key: string, value: T) => {
      puts.push({ store, key });
      return orig(store, key, value);
    };
    return { db, puts };
  }

  it('debounces writes and keeps the latest state', async () => {
    const { db, puts } = countingDb();
    const auto = new AutosaveManager(db, { delayMs: 800, flushOnHide: false });
    auto.schedule('p1', editState(0.1));
    await vi.advanceTimersByTimeAsync(500);
    auto.schedule('p1', editState(0.2));
    await vi.advanceTimersByTimeAsync(500);
    auto.schedule('p1', editState(0.3));
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    await auto.flush();
    expect(puts.filter((p) => p.store === 'edits')).toHaveLength(1);
    expect((await db.get<SerializedEditState>('edits', 'p1'))?.params.basic.exposure).toBe(0.3);
    const rec = await db.get<{ dirty: boolean; photoId: string }>('autosave', AUTOSAVE_SESSION_KEY);
    expect(rec?.dirty).toBe(true);
    expect(rec?.photoId).toBe('p1');
  });

  it('exposes a dirty session for recovery until markClean / discardRecovery', async () => {
    const db = new MemoryKloudDB();
    const a = new AutosaveManager(db, { delayMs: 800, flushOnHide: false, now: () => 1234 });
    a.schedule('p9', editState(1.5));
    await a.flush();
    // "Crash": a new manager (next page load) finds the dirty session.
    const b = new AutosaveManager(db, { flushOnHide: false });
    const rec = await b.getRecovery();
    expect(rec).toMatchObject({ photoId: 'p9', savedAt: 1234 });
    expect(rec?.state.params.basic.exposure).toBe(1.5);

    await b.markClean();
    expect(await b.getRecovery()).toBeNull();

    a.schedule('p9', editState(2));
    await a.flush();
    expect(await b.getRecovery()).not.toBeNull();
    await b.discardRecovery();
    expect(await b.getRecovery()).toBeNull();
  });

  it('flushes the previous photo immediately when switching photos', async () => {
    const db = new MemoryKloudDB();
    const auto = new AutosaveManager(db, { delayMs: 800, flushOnHide: false });
    auto.schedule('a', editState(0.5));
    auto.schedule('b', editState(0.7));
    await vi.advanceTimersByTimeAsync(0);
    expect((await db.get<SerializedEditState>('edits', 'a'))?.params.basic.exposure).toBe(0.5);
    expect(await db.get('edits', 'b')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    await auto.flush();
    expect((await db.get<SerializedEditState>('edits', 'b'))?.params.basic.exposure).toBe(0.7);
    expect((await auto.getRecovery())?.photoId).toBe('b');
  });

  it('uses the save hook and retries a failed flush', async () => {
    const db = new MemoryKloudDB();
    const saved: string[] = [];
    let fail = true;
    const auto = new AutosaveManager(db, {
      flushOnHide: false,
      onError: () => undefined,
      save: async (id) => {
        if (fail) throw new Error('disk full');
        saved.push(id);
      },
    });
    auto.schedule('x', editState(1));
    await expect(auto.flush()).rejects.toThrow('disk full');
    expect(auto.pendingPhotoId).toBe('x');
    fail = false;
    await auto.markClean();
    expect(saved).toEqual(['x']);
    expect(await auto.getRecovery()).toBeNull();
  });
});
