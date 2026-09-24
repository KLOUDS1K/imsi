/**
 * library/ — the photo library model (records, albums, folders, import,
 * query/facets, thumbnails) and batch develop operations.
 *
 *   const db = await openDB();
 *   const lib = await openLibrary(db);             // io functions load lazily on first import
 *   lib.subscribe(() => grid.render(lib.query(q))); // one notification per tick of mutations
 *   const added = await lib.importFiles(files, { onProgress, signal });
 *   lib.lastImportReport;                           // duplicates / unsupported / failed / warnings
 *
 * Notes for other modules:
 * - Records and albums are immutable snapshots (frozen in dev builds); change
 *   them through the Library methods. Reads (`all`, `query`, `facets`,
 *   `folders`, `albums`) are synchronous.
 * - importFiles never rejects for a single bad file: per-file failures are in
 *   `ImportProgressDetail.errors` (onProgress), `opts.onError`, and
 *   `lib.lastImportReport` / `importFilesDetailed()`. Aborting resolves with
 *   the photos imported so far.
 * - Use `lib.saveEdit` (not `db.put('edits')`) so `hasEdits/editedAt` stay in
 *   sync; for autosave: `new AutosaveManager(db, { save: (id, s) => lib.saveEdit(id, s) })`.
 * - Batch operations (syncSettings, batchApplyPreset, applyPrevious) update
 *   stored edits only; reload the edit of the photo open in the editor
 *   afterwards (or pass `onApplied` in the trailing options). They throw a
 *   `BatchError` listing failed targets after processing all the others.
 */
import type { BatchModule, KloudDB, LibraryApi } from '@/editor/contracts';
import { applyPrevious, batchApplyPreset, copySettings, pasteSettings, syncSettings } from './batch';
import { Library, openLibrary, type LibraryDeps } from './library';

export { Library, openLibrary, type LibraryDeps } from './library';
export {
  appendHistoryStep,
  applyPrevious,
  batchApplyPreset,
  BatchError,
  copySettings,
  normalizeGroups,
  pasteSettings,
  portablePartial,
  syncSettings,
  type BatchFailure,
  type BatchOptions,
  type SettingsClip,
} from './batch';
export {
  dedupeKey,
  type ImportDeps,
  type ImportIssue,
  type ImportOptions,
  type ImportProgressDetail,
  type ImportReport,
} from './import';
export {
  cameraName,
  compileFilter,
  computeFacets,
  DEFAULT_SORT,
  DEFAULT_SORT_ORDER,
  effectiveDate,
  effectiveDateMs,
  RECENT_EDIT_MS,
  runQuery,
  sortRecords,
} from './query';
export {
  compareFolders,
  defaultImportFolder,
  expandFolders,
  folderFromRelativePath,
  folderName,
  isInFolder,
  normalizeFolder,
  parentFolder,
} from './folders';
export { COLOR_LABELS, PICK_FLAGS, clampRating, isColorLabel, isPickFlag, isRawRecord, sanitizeRecord } from './records';
export { cropAspect, fitSyncedCrop, frameDims, refitCropRect } from './crop';
export { foldText, parseSearchTerms } from './text';
export { ThumbnailUrlCache } from './thumbs';

export const batchModule = {
  copySettings,
  pasteSettings,
  syncSettings,
  batchApplyPreset,
  applyPrevious,
} satisfies BatchModule;

/** Compile-time check that the Library class and openLibrary match the LibraryApi contract. */
export const libraryModule = { Library, openLibrary } satisfies {
  Library: new (db: KloudDB, data?: never, deps?: LibraryDeps) => LibraryApi;
  openLibrary: (db: KloudDB, deps?: LibraryDeps) => Promise<LibraryApi>;
};
