/**
 * ui/batch — multi-photo develop operations with their dialogs.
 *
 *   openCopySettingsDialog(ctx, sourceId?)      → ctx.settingsClipboard
 *   pasteSettings(ctx, ids)                     → apply ctx.settingsClipboard
 *   openSyncDialog(ctx, sourceId, targetIds)    → group checklist + quick presets, then sync
 *   openBatchPresetDialog(ctx, ids)             → preset picker + amount
 *   runAiAutoBatch(ctx, ids)                    → analyze + auto edit each photo (cancellable)
 *   applyPreviousEdit(ctx, ids)                 → settings of the previously edited photo
 *
 * The photo open in Develop is always updated through its EditorStore (one
 * undoable step); every other photo through the library's batch functions.
 * Afterwards thumbnails of changed photos are re-rendered in the background
 * when an engine is available (queueThumbnailRefresh).
 *
 * Progress shows in a small cancellable card and in ctx.busy.
 */
export { openCopySettingsDialog, openSyncDialog, openBatchPresetDialog, runSync, runBatchPreset, reportBatchError } from './dialogs';
export { runAiAutoBatch, applyPreviousEdit, pasteSettings, mergeAutoEdit, trackPreviousPhoto, findPreviousPhoto, type AutoBatchResult } from './auto';
export { editPhotos, loadPhotoParams, splitOpenDoc, type EditManyOptions } from './edits';
export { queueThumbnailRefresh, renderedToBlob, fitLongEdge } from './thumbs';
export { createGroupChecklist, GROUP_LABELS, GROUP_CATEGORIES, QUICK_PRESETS, defaultSyncGroups, type GroupChecklist, type QuickPresetId } from './groups';
export { startBatchProgress, type BatchProgress } from './progress';
