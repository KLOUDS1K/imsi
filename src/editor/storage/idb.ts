/**
 * IndexedDB-backed KloudDB. Thin promise wrappers around one transaction per
 * call; `getMany`/`batch` share a single transaction for bulk work (imports,
 * removals, multi-photo updates).
 *
 * The connection is re-established lazily when the browser closes it (another
 * tab upgrading the schema → `versionchange`, or the user clearing site data →
 * `close`), so a long-lived editor tab keeps working.
 */
import type { StoreName } from '@/editor/contracts';
import { DB_NAME, DB_VERSION, STORE_NAMES, type DBOp, type KloudDBExt } from './schema';
import { storageEstimate } from './estimate';

/** Resolve with the request's result, reject with its error. */
export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed', 'UnknownError'));
  });
}

/** Resolve when a transaction commits; reject when it errors or aborts. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new DOMException('IndexedDB transaction failed', 'UnknownError'));
    tx.onabort = () => reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
  });
}

export interface OpenIdbOptions {
  factory: IDBFactory;
  name?: string;
  /** Schema version to request; `null` opens whatever version exists (creating v1 when absent). */
  version?: number | null;
  /** Give up (and let the caller fall back) when open neither succeeds nor fails in time. */
  timeoutMs?: number;
}

/**
 * Open (creating/upgrading) the database. Every missing object store is
 * created in `onupgradeneeded`, so bumping the version is all a future schema
 * addition needs.
 */
export function openIdbDatabase(opts: OpenIdbOptions): Promise<IDBDatabase> {
  const { factory, name = DB_NAME, version = DB_VERSION, timeoutMs = 10_000 } = opts;
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = version === null ? factory.open(name) : factory.open(name, version);
    } catch (err) {
      // SecurityError in sandboxed/opaque-origin frames, InvalidStateError in some private modes.
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DOMException(`Opening IndexedDB "${name}" timed out after ${timeoutMs} ms`, 'TimeoutError'));
    }, timeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // Timed out earlier and the caller already fell back: release the late connection.
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(request.error ?? new DOMException('IndexedDB open failed', 'UnknownError'));
    };
    // onblocked: an older connection in another tab has not closed yet. Keep waiting;
    // our own connections close on `versionchange`, and the timeout covers a stuck tab.
  });
}

/**
 * Open the database and make sure it is usable: every store exists (repairing
 * a stale database of the same name by bumping the version) and a write
 * actually succeeds (old Safari private mode opens fine but throws on write).
 */
export async function openVerifiedDatabase(opts: OpenIdbOptions): Promise<IDBDatabase> {
  let db = await openIdbDatabase(opts);
  const missing = STORE_NAMES.filter((s) => !db.objectStoreNames.contains(s));
  if (missing.length > 0) {
    const nextVersion = db.version + 1;
    db.close();
    db = await openIdbDatabase({ ...opts, version: nextVersion });
  }
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  store.put(1, '__kloud_probe__');
  store.delete('__kloud_probe__');
  try {
    await transactionDone(tx);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export class IdbKloudDB implements KloudDBExt {
  readonly backend = 'indexeddb' as const;
  private db: IDBDatabase | null = null;
  private reopening: Promise<IDBDatabase> | null = null;

  constructor(
    db: IDBDatabase,
    private readonly openOpts: OpenIdbOptions,
  ) {
    this.attach(db);
  }

  private attach(db: IDBDatabase): void {
    this.db = db;
    db.onversionchange = () => {
      // Another tab wants to upgrade: step aside, reconnect on next use.
      db.close();
      if (this.db === db) this.db = null;
    };
    db.onclose = () => {
      if (this.db === db) this.db = null;
    };
  }

  private connection(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (!this.reopening) {
      // `null`: accept whatever version is current now (another tab may have upgraded it).
      this.reopening = openVerifiedDatabase({ ...this.openOpts, version: null }).then(
        (db) => {
          this.reopening = null;
          this.attach(db);
          return db;
        },
        (err: unknown) => {
          this.reopening = null;
          throw err;
        },
      );
    }
    return this.reopening;
  }

  /** Create a transaction, reconnecting once when the connection was closed underneath us. */
  private async transaction(stores: StoreName | StoreName[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await this.connection();
    try {
      return db.transaction(stores, mode);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'InvalidStateError') {
        if (this.db === db) this.db = null;
        return (await this.connection()).transaction(stores, mode);
      }
      throw err;
    }
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const tx = await this.transaction(store, 'readonly');
    return (await promisifyRequest(tx.objectStore(store).get(key))) as T | undefined;
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    const tx = await this.transaction(store, 'readwrite');
    const done = transactionDone(tx);
    try {
      tx.objectStore(store).put(value, key);
    } catch (err) {
      // DataCloneError etc. are thrown synchronously; abort so the transaction does not linger.
      abortQuietly(tx);
      done.catch(() => undefined);
      throw err;
    }
    await done;
  }

  async delete(store: StoreName, key: string): Promise<void> {
    const tx = await this.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await transactionDone(tx);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    const tx = await this.transaction(store, 'readonly');
    return (await promisifyRequest(tx.objectStore(store).getAll())) as T[];
  }

  async keys(store: StoreName): Promise<string[]> {
    const tx = await this.transaction(store, 'readonly');
    const keys = await promisifyRequest(tx.objectStore(store).getAllKeys());
    return keys.map((k) => String(k));
  }

  async clear(store: StoreName): Promise<void> {
    const tx = await this.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await transactionDone(tx);
  }

  async getMany<T>(store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const tx = await this.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    return (await Promise.all(keys.map((k) => promisifyRequest(os.get(k))))) as (T | undefined)[];
  }

  async batch(ops: readonly DBOp[]): Promise<void> {
    if (ops.length === 0) return;
    const stores = [...new Set(ops.map((o) => o.store))];
    const tx = await this.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    try {
      for (const op of ops) {
        const os = tx.objectStore(op.store);
        if (op.type === 'put') os.put(op.value, op.key);
        else os.delete(op.key);
      }
    } catch (err) {
      abortQuietly(tx);
      done.catch(() => undefined);
      throw err;
    }
    await done;
  }

  estimate(): Promise<{ usage: number; quota: number }> {
    return storageEstimate();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    /* already finished */
  }
}
