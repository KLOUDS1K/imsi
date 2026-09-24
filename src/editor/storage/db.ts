/**
 * KloudDB — the app's persistence layer (contract: `KloudDB` in contracts.ts).
 *
 * `openDB()` opens the IndexedDB database 'kloud-studio' (one object store per
 * StoreName, out-of-line keys). When IndexedDB is missing, blocked, or broken
 * (private browsing, sandboxed iframes, disabled site data, a stuck upgrade),
 * it falls back to an in-memory database so the editor still works for the
 * session; that is logged once and reported through `db.backend === 'memory'`.
 */
import type { KloudDB, StoreName } from '@/editor/contracts';
import { IdbKloudDB, openVerifiedDatabase, type OpenIdbOptions } from './idb';
import { MemoryKloudDB } from './memory';
import { requestPersistentStorage } from './estimate';
import { DB_NAME, DB_VERSION, isExtendedDB, type DBOp, type KloudDBExt } from './schema';

export { IdbKloudDB, MemoryKloudDB };

export interface OpenDBOptions {
  /** Database name (tests use unique names). Default 'kloud-studio'. */
  name?: string;
  /** IDBFactory to use; defaults to the global `indexedDB`. */
  factory?: IDBFactory | null;
  /** Skip IndexedDB entirely. */
  memory?: boolean;
  /** Ask the browser to make storage persistent (best-effort, fire-and-forget). Default true. */
  persist?: boolean;
  /** Give up on a hanging open after this long and fall back to memory. Default 10 s. */
  timeoutMs?: number;
}

let fallbackLogged = false;

function logFallbackOnce(reason: unknown): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  const why = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.warn(`[kloud/storage] IndexedDB unavailable (${why}). Using in-memory storage: changes will not survive a reload.`);
}

function globalIndexedDB(): IDBFactory | null {
  try {
    // Merely touching `indexedDB` throws SecurityError in some sandboxed frames.
    return typeof indexedDB !== 'undefined' && indexedDB ? indexedDB : null;
  } catch {
    return null;
  }
}

/**
 * Open the app database. Never rejects: any IndexedDB failure yields a
 * working in-memory KloudDB instead (check `backend` to warn the user).
 */
export async function openDB(opts: OpenDBOptions = {}): Promise<KloudDBExt> {
  if (opts.memory) return new MemoryKloudDB();
  const factory = opts.factory === undefined ? globalIndexedDB() : opts.factory;
  if (!factory) {
    logFallbackOnce('indexedDB is not available in this context');
    return new MemoryKloudDB();
  }
  const openOpts: OpenIdbOptions = { factory, name: opts.name ?? DB_NAME, version: DB_VERSION, timeoutMs: opts.timeoutMs };
  try {
    let db: IDBDatabase;
    try {
      db = await openVerifiedDatabase(openOpts);
    } catch (err) {
      // A newer build already upgraded the database: open it at its current version.
      if (!(err instanceof DOMException && err.name === 'VersionError')) throw err;
      db = await openVerifiedDatabase({ ...openOpts, version: null });
    }
    if (opts.persist !== false) void requestPersistentStorage();
    return new IdbKloudDB(db, openOpts);
  } catch (err) {
    logFallbackOnce(err);
    return new MemoryKloudDB();
  }
}

/** Delete the whole database (tests, "reset app" in settings). Resolves false when blocked or unavailable. */
export function deleteDatabase(name = DB_NAME, factory: IDBFactory | null = globalIndexedDB()): Promise<boolean> {
  if (!factory) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Helpers that work with any KloudDB (fast path when extended)        */
/* ------------------------------------------------------------------ */

/** Read several keys (one transaction on the IndexedDB backend). */
export function getMany<T>(db: KloudDB, store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]> {
  if (isExtendedDB(db)) return db.getMany<T>(store, keys);
  return Promise.all(keys.map((k) => db.get<T>(store, k)));
}

/**
 * Apply writes atomically in one transaction when the backend supports it;
 * otherwise sequentially (a plain KloudDB, e.g. a test double).
 */
export async function runBatch(db: KloudDB, ops: readonly DBOp[]): Promise<void> {
  if (ops.length === 0) return;
  if (isExtendedDB(db)) return db.batch(ops);
  for (const op of ops) {
    if (op.type === 'put') await db.put(op.store, op.key, op.value);
    else await db.delete(op.store, op.key);
  }
}

/** Which backend a KloudDB uses ('unknown' for foreign implementations). */
export function backendOf(db: KloudDB): 'indexeddb' | 'memory' | 'unknown' {
  return isExtendedDB(db) ? db.backend : 'unknown';
}
