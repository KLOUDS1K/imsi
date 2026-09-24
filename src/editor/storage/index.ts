/**
 * storage/ — IndexedDB persistence, autosave/crash recovery, app settings.
 *
 * Usage notes for other modules:
 * - `openDB()` never rejects; it falls back to an in-memory database when
 *   IndexedDB is unavailable. `backendOf(db) === 'memory'` → tell the user that
 *   nothing will be kept after a reload.
 * - Stored values are structured clones: mutate what you read freely, and
 *   always `put` again to persist a change.
 * - For bulk work use `getMany()` / `runBatch()` (one transaction; atomic).
 * - Keys of 'maskBitmaps' / 'patches' are the `bitmapKey` / `patchKey` stored in
 *   the edit params; the library deletes the ones only referenced by removed
 *   photos.
 */
import type { StorageModule } from '@/editor/contracts';
import { openDB } from './db';
import { AutosaveManager } from './autosave';
import { loadSetting, saveSetting } from './settings';

export { openDB, deleteDatabase, getMany, runBatch, backendOf, IdbKloudDB, MemoryKloudDB, type OpenDBOptions } from './db';
export { AutosaveManager, type AutosaveOptions } from './autosave';
export { loadSetting, saveSetting, deleteSetting } from './settings';
export { storageEstimate, requestPersistentStorage } from './estimate';
export { promisifyRequest, transactionDone } from './idb';
export {
  AUTOSAVE_SESSION_KEY,
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  isExtendedDB,
  isStoreName,
  type AutosaveRecord,
  type DBOp,
  type KloudDBExt,
} from './schema';

export const storageModule = {
  openDB,
  AutosaveManager,
  loadSetting,
  saveSetting,
} satisfies StorageModule;
