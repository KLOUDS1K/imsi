/**
 * Reading and writing the saved edit of any photo, whether it is the one open
 * in Develop (its live EditorStore is the source of truth — writing the
 * database behind its back would be overwritten by autosave) or a photo that
 * only exists in the library.
 */
import type { AppContext } from '@/app/context';
import { createDefaultParams } from '@/editor/defaults';
import { normalizeParams } from '@/editor/state';
import { appendHistoryStep } from '@/editor/library';
import type { EditParams, PhotoRecord } from '@/editor/types';
import { queueThumbnailRefresh } from './thumbs';

export const isRawRecord = (r: Pick<PhotoRecord, 'meta'> | undefined): boolean => r?.meta?.format === 'raw';

/** Current params of a photo: the open document's store, else the saved edit, else defaults. */
export async function loadPhotoParams(ctx: AppContext, id: string): Promise<EditParams> {
  const doc = ctx.doc.value;
  if (doc && doc.photoId === id) return doc.store.params;
  const rec = ctx.library.get(id);
  const raw = isRawRecord(rec);
  const saved = await ctx.library.loadEdit(id);
  return saved ? normalizeParams(saved.params, raw) : createDefaultParams(raw);
}

export interface EditManyOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, name?: string) => void;
  /** Regenerate thumbnails of changed photos (default true). */
  thumbnails?: boolean;
}

/**
 * Apply `transform` to each photo's params and persist it with a history step
 * named `label`. Returns the ids that were changed. Stops early (without
 * throwing) when `signal` aborts.
 */
export async function editPhotos(
  ctx: AppContext,
  ids: readonly string[],
  label: string,
  transform: (params: EditParams, rec: PhotoRecord) => EditParams | Promise<EditParams>,
  opts: EditManyOptions = {},
): Promise<string[]> {
  const changed: string[] = [];
  const total = ids.length;
  let done = 0;
  opts.onProgress?.(0, total);
  for (const id of ids) {
    if (opts.signal?.aborted) break;
    const rec = ctx.library.get(id);
    if (!rec) {
      opts.onProgress?.(++done, total);
      continue;
    }
    const doc = ctx.doc.value;
    if (doc && doc.photoId === id) {
      const next = await transform(doc.store.params, rec);
      if (next !== doc.store.params) {
        doc.store.replace(next, label);
        ctx.requestRender();
        changed.push(id);
      }
    } else {
      const raw = isRawRecord(rec);
      const prev = await ctx.library.loadEdit(id);
      const cur = prev ? normalizeParams(prev.params, raw) : createDefaultParams(raw);
      const next = await transform(cur, rec);
      if (next !== cur) {
        await ctx.library.saveEdit(id, appendHistoryStep(prev, createDefaultParams(raw), next, label, Date.now()));
        changed.push(id);
      }
    }
    opts.onProgress?.(++done, total, rec.name);
  }
  if (opts.thumbnails !== false && changed.length > 0) queueThumbnailRefresh(ctx, changed);
  return changed;
}

/** Split ids into the open document's id (if present) and the rest. */
export function splitOpenDoc(ctx: AppContext, ids: readonly string[]): { docId: string | null; others: string[] } {
  const docId = ctx.doc.value?.photoId ?? null;
  const has = docId !== null && ids.includes(docId);
  return { docId: has ? docId : null, others: has ? ids.filter((id) => id !== docId) : [...ids] };
}
