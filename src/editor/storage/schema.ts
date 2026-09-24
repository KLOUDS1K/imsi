/**
 * Persistent storage layout shared by the IndexedDB and in-memory backends.
 *
 * One object store per `StoreName`, all with out-of-line string keys:
 *
 * | store         | key                      | value                                   |
 * | ------------- | ------------------------ | --------------------------------------- |
 * | photos        | photo id                 | PhotoRecord                             |
 * | files         | photo id                 | original Blob/File                      |
 * | thumbs        | photo id                 | JPEG Blob (grid thumbnail)              |
 * | edits         | photo id                 | SerializedEditState                     |
 * | presets       | preset id                | Preset                                  |
 * | albums        | album id                 | Album                                   |
 * | settings      | setting key              | any structured-cloneable value          |
 * | autosave      | AUTOSAVE_SESSION_KEY     | AutosaveRecord (crash recovery)         |
 * | styleModels   | model id                 | StyleModel                              |
 * | stylePairs    | pair id                  | StylePair                               |
 * | maskBitmaps   | AiMaskParams.bitmapKey   | MaskBitmap                              |
 * | patches       | RemovalPatch.patchKey    | PixelBuffer (RGBA8 patch pixels)        |
 */
import type { KloudDB, RecoverySession, StoreName } from '@/editor/contracts';

export const DB_NAME = 'kloud-studio';
export const DB_VERSION = 1;

/** Exhaustive by construction: adding a StoreName without listing it here is a type error. */
const STORE_TABLE: Record<StoreName, true> = {
  photos: true,
  files: true,
  thumbs: true,
  edits: true,
  presets: true,
  albums: true,
  settings: true,
  autosave: true,
  styleModels: true,
  stylePairs: true,
  maskBitmaps: true,
  patches: true,
};

export const STORE_NAMES: readonly StoreName[] = Object.freeze(Object.keys(STORE_TABLE) as StoreName[]);

export function isStoreName(v: unknown): v is StoreName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STORE_TABLE, v);
}

/** Key of the single crash-recovery record in the 'autosave' store. */
export const AUTOSAVE_SESSION_KEY = 'session';

/** What AutosaveManager persists in the 'autosave' store. */
export interface AutosaveRecord extends RecoverySession {
  /** true until the session is closed cleanly (markClean). */
  dirty: boolean;
}

/** One write inside an atomic multi-store batch. */
export type DBOp =
  | { type: 'put'; store: StoreName; key: string; value: unknown }
  | { type: 'delete'; store: StoreName; key: string };

/**
 * Optional capabilities of the KloudDB returned by `openDB()`. Code that only
 * receives a `KloudDB` (the contract type) should go through `getMany()` /
 * `runBatch()` from `@/editor/storage`, which use these when present and fall
 * back to single operations otherwise (e.g. for test doubles).
 */
export interface KloudDBExt extends KloudDB {
  /** 'memory' = IndexedDB was unavailable; nothing survives a reload. */
  readonly backend: 'indexeddb' | 'memory';
  /** Several reads in one transaction; `undefined` for missing keys. */
  getMany<T>(store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]>;
  /** All writes in ONE read-write transaction spanning the stores involved (all-or-nothing). */
  batch(ops: readonly DBOp[]): Promise<void>;
  /** Close the connection (tests, page teardown). Further calls reopen lazily (IndexedDB) or keep working (memory). */
  close(): void;
}

export function isExtendedDB(db: KloudDB): db is KloudDBExt {
  const d = db as Partial<KloudDBExt>;
  return typeof d.batch === 'function' && typeof d.getMany === 'function';
}
