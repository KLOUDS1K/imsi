/**
 * Batch develop operations (contract: `BatchModule`): copy/paste settings,
 * sync to many photos, apply a preset to many photos, "Previous".
 *
 * Semantics shared by every multi-photo operation:
 * - Each target's current edit is loaded (or its defaults, via
 *   `normalizeParams(undefined, isRaw)`), changed, and saved through
 *   `lib.saveEdit` so `PhotoRecord.hasEdits/editedAt` stay in sync. The change
 *   is appended as ONE history step ("Sync Settings", "Preset: …", "Previous"),
 *   dropping any redo branch, so it can be undone when the photo is opened.
 *   Targets whose params would not change are left untouched (no empty steps).
 * - Photo-specific data never travels between photos: AI mask bitmap keys are
 *   dropped (the masks module recomputes the bitmap for the target on demand)
 *   and generative-removal patches (pixels of the SOURCE photo) are not copied;
 *   the target keeps its own removals. Heal/clone spots are parametric and do
 *   copy.
 * - Crop: the relative rect, straighten angle, orientation and flips copy;
 *   a locked aspect is re-fitted to the target's frame shape (see crop.ts),
 *   and constrained to valid image data when the target is transformed.
 * - Targets run a few at a time. A failing target does not stop the others;
 *   after the batch a `BatchError` listing the failures is thrown.
 * - Photos open in the editor are NOT updated live: pass `onApplied` (extra
 *   options argument) or reload the active photo's edit after the call.
 */
import type { BatchModule, LibraryApi } from '@/editor/contracts';
import type { EditParams, HistoryEntry, PartialParams, PhotoMeta, PhotoRecord, Preset, SerializedEditState, SettingsGroup } from '@/editor/types';
import { SETTINGS_GROUPS } from '@/editor/types';
import { applyPartial, diffPaths, normalizeParams, pickGroups } from '@/editor/state';
import { applyPreset } from '@/editor/presets';
import { fitSyncedCrop, type CropValidator } from './crop';
import { runPool } from './import';
import { isRawRecord } from './records';

/** Clipboard produced by copySettings. */
export interface SettingsClip {
  groups: SettingsGroup[];
  params: PartialParams;
}

/** Extra, optional knobs for the multi-photo operations (not part of the contract). */
export interface BatchOptions {
  signal?: AbortSignal;
  /** Called after each target was saved (e.g. to reload the photo open in the editor). */
  onApplied?: (id: string, state: SerializedEditState) => void;
  /** Crop validity test for `constrainToImage`; default: the engine's CPU geometry mirror when loadable. */
  cropValidator?: ((meta: PhotoMeta) => CropValidator | null) | null;
  /** Targets processed in parallel. Default 4. */
  concurrency?: number;
  /** History label of the step added to each target. */
  label?: string;
  /** Clock (tests). */
  now?: () => number;
}

export interface BatchFailure {
  id: string;
  error: unknown;
}

/** Thrown after a batch in which some targets failed; the others were saved. */
export class BatchError extends Error {
  constructor(
    readonly failures: BatchFailure[],
    readonly succeeded: number,
  ) {
    super(`${failures.length} photo${failures.length === 1 ? '' : 's'} could not be updated`);
    this.name = 'BatchError';
  }
}

/** Entries kept in a batch-written history (same as EditorStore.serialize). */
const MAX_HISTORY = 50;

const GROUP_SET: ReadonlySet<string> = new Set(SETTINGS_GROUPS);

/** Valid, de-duplicated groups in canonical order. */
export function normalizeGroups(groups: readonly unknown[] | undefined): SettingsGroup[] {
  if (!groups) return [];
  const set = new Set(groups.filter((g): g is SettingsGroup => typeof g === 'string' && GROUP_SET.has(g)));
  return SETTINGS_GROUPS.filter((g) => set.has(g));
}

/* ------------------------------------------------------------------ */
/* Portability of partials between photos                              */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Copy of `partial` that is safe to apply to `target`: AI mask bitmap keys
 * removed, removal patches replaced by the target's own.
 */
export function portablePartial(partial: PartialParams, target: EditParams): PartialParams {
  const out = structuredClone(partial) as Obj;
  if (Array.isArray(out.masks)) {
    for (const mask of out.masks as unknown[]) {
      if (!isObj(mask) || !Array.isArray(mask.components)) continue;
      for (const comp of mask.components as unknown[]) {
        if (isObj(comp) && isObj(comp.ai)) delete comp.ai.bitmapKey;
      }
    }
  }
  if (isObj(out.retouch) && out.retouch.removals !== undefined) {
    out.retouch.removals = structuredClone(target.retouch.removals);
  }
  return out as PartialParams;
}

/* ------------------------------------------------------------------ */
/* Copy / paste                                                        */
/* ------------------------------------------------------------------ */

/** Snapshot of `groups` of `params` (deep copy; later edits of the source do not leak in). */
export function copySettings(params: EditParams, groups: SettingsGroup[]): SettingsClip {
  const gs = normalizeGroups(groups);
  return { groups: gs, params: pickGroups(params, gs) };
}

/**
 * Apply a clipboard to `target` (returns new params). Pass the target photo's
 * `meta` to re-fit an aspect-locked crop to its frame (the viewer's paste
 * does; without it the relative rect is copied as-is).
 */
export function pasteSettings(target: EditParams, clip: SettingsClip, opts: { meta?: Pick<PhotoMeta, 'width' | 'height'> } = {}): EditParams {
  const groups = normalizeGroups(clip.groups);
  if (groups.length === 0) return target;
  let next = applyPartial(target, portablePartial(clip.params, target), groups);
  if (groups.includes('crop') && opts.meta) next = fitSyncedCrop(next, opts.meta);
  return next;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/**
 * `prev` (or a fresh state starting at `base`) with `params` appended as one
 * history step. A redo branch after the current entry is discarded, exactly
 * like a new edit in the editor would.
 */
export function appendHistoryStep(
  prev: SerializedEditState | undefined,
  base: EditParams,
  params: EditParams,
  label: string,
  now: number,
): SerializedEditState {
  const src = prev && Array.isArray(prev.history) ? prev.history : [];
  const idx = prev ? Math.max(-1, Math.min(src.length - 1, Math.floor(prev.historyIndex))) : -1;
  const kept: HistoryEntry[] = src.slice(0, idx + 1);
  if (kept.length === 0) kept.push({ id: 0, label: 'Import', params: base, time: prev?.updated ?? now });
  const nextId = kept.reduce((m, e) => Math.max(m, typeof e.id === 'number' ? e.id : 0), 0) + 1;
  kept.push({ id: nextId, label, params, time: now });
  const history = kept.slice(-MAX_HISTORY);
  return {
    format: 'kloud-edit',
    version: 1,
    params,
    history,
    historyIndex: history.length - 1,
    snapshots: prev && Array.isArray(prev.snapshots) ? prev.snapshots : [],
    updated: now,
  };
}

/* ------------------------------------------------------------------ */
/* Multi-photo driver                                                  */
/* ------------------------------------------------------------------ */

type Geometry = typeof import('@/editor/engine/geometry');
let geometryPromise: Promise<Geometry | null> | null = null;

/** The engine's CPU geometry mirror (lazy; null when it cannot load, e.g. a missing lens module). */
function loadGeometry(): Promise<Geometry | null> {
  geometryPromise ??= import('@/editor/engine/geometry').then(
    (g) => g,
    (err: unknown) => {
      console.warn('[kloud/library] geometry unavailable; synced crops are not constrained to the image', err);
      return null;
    },
  );
  return geometryPromise;
}

async function defaultCropValidator(): Promise<(meta: PhotoMeta) => CropValidator | null> {
  const geo = await loadGeometry();
  if (!geo) return () => null;
  return (meta) => {
    if (!(meta.width > 0 && meta.height > 0)) return null;
    return (params, rect) => geo.isCropValid(params, meta.width, meta.height, rect, geo.lensCorrectionFor(params, meta));
  };
}

interface TargetContext {
  record: PhotoRecord;
  base: EditParams;
  isRaw: boolean;
}

/** Load each target, compute its new params with `transform`, save as one history step. */
async function forEachTarget(
  lib: LibraryApi,
  targetIds: readonly string[],
  transform: (ctx: TargetContext) => EditParams,
  opts: BatchOptions & { label: string },
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const ids = [...new Set(targetIds)];
  const total = ids.length;
  const now = opts.now ?? Date.now;
  const failures: BatchFailure[] = [];
  let done = 0;
  let succeeded = 0;
  const report = () => {
    try {
      onProgress?.(done, total);
    } catch (err) {
      console.error('[kloud/library] batch onProgress callback threw', err);
    }
  };
  report();

  await runPool(
    ids,
    opts.concurrency ?? 4,
    async (id) => {
      try {
        const record = lib.get(id);
        if (!record) return; // removed meanwhile: nothing to do
        const isRaw = isRawRecord(record);
        const prev = await lib.loadEdit(id);
        const base = normalizeParams(prev?.params, isRaw);
        const next = transform({ record, base, isRaw });
        if (opts.signal?.aborted) return;
        if (diffPaths(base, next).length === 0) {
          // Already identical: no empty history step, no edit record for untouched photos.
          succeeded++;
          return;
        }
        const state = appendHistoryStep(prev, base, next, opts.label, now());
        await lib.saveEdit(id, state);
        succeeded++;
        opts.onApplied?.(id, state);
      } catch (err) {
        failures.push({ id, error: err });
      } finally {
        done++;
        report();
      }
    },
    opts.signal,
  );
  if (failures.length > 0) throw new BatchError(failures, succeeded);
}

async function resolveValidator(opts: BatchOptions): Promise<(meta: PhotoMeta) => CropValidator | null> {
  if (opts.cropValidator === null) return () => null;
  return opts.cropValidator ?? (await defaultCropValidator());
}

/**
 * Apply `groups` of `source` to every target (Lightroom "Sync Settings").
 * See the module comment for crop, masks and removal handling.
 */
export async function syncSettings(
  lib: LibraryApi,
  source: EditParams,
  targetIds: string[],
  groups: SettingsGroup[],
  onProgress?: (done: number, total: number) => void,
  opts: BatchOptions = {},
): Promise<void> {
  const gs = normalizeGroups(groups);
  if (gs.length === 0) return;
  const clip = pickGroups(source, gs);
  const validatorFor = gs.includes('crop') ? await resolveValidator(opts) : () => null;
  await forEachTarget(
    lib,
    targetIds,
    ({ record, base }) => {
      let next = applyPartial(base, portablePartial(clip, base), gs);
      if (gs.includes('crop')) next = fitSyncedCrop(next, record.meta, validatorFor(record.meta));
      return next;
    },
    { ...opts, label: opts.label ?? 'Sync Settings' },
    onProgress,
  );
}

/** "Preset: Name" / "Preset: Name (80%)". */
function presetStepLabel(preset: Preset, amount: number): string {
  const a = Math.round(amount);
  return a === 100 ? `Preset: ${preset.name}` : `Preset: ${preset.name} (${a}%)`;
}

/** Apply `preset` at `amount` % (0..200, default 100) to every target. */
export async function batchApplyPreset(
  lib: LibraryApi,
  preset: Preset,
  targetIds: string[],
  amount = 100,
  onProgress?: (done: number, total: number) => void,
  opts: BatchOptions = {},
): Promise<void> {
  const touchesCrop = preset.groups?.includes('crop') || preset.params?.crop !== undefined;
  const validatorFor = touchesCrop ? await resolveValidator(opts) : () => null;
  await forEachTarget(
    lib,
    targetIds,
    ({ record, base }) => {
      let next = applyPreset(base, { ...preset, params: portablePartial(preset.params ?? {}, base) }, amount);
      if (touchesCrop) next = fitSyncedCrop(next, record.meta, validatorFor(record.meta));
      return next;
    },
    { ...opts, label: opts.label ?? presetStepLabel(preset, amount) },
    onProgress,
  );
}

/**
 * Lightroom "Previous": give the targets the settings of `previousId`
 * (all groups unless `groups` is given). The previous photo itself is skipped.
 * Rejects when `previousId` is not in the library.
 */
export async function applyPrevious(
  lib: LibraryApi,
  previousId: string,
  targetIds: string[],
  groups?: SettingsGroup[],
  onProgress?: (done: number, total: number) => void,
  opts: BatchOptions = {},
): Promise<void> {
  const prev = lib.get(previousId);
  if (!prev) throw new Error(`Previous photo not found: ${previousId}`);
  const edit = await lib.loadEdit(previousId);
  const source = normalizeParams(edit?.params, isRawRecord(prev));
  const targets = targetIds.filter((id) => id !== previousId);
  await syncSettings(lib, source, targets, groups ?? [...SETTINGS_GROUPS], onProgress, { ...opts, label: opts.label ?? 'Previous' });
}
