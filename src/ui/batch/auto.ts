/**
 * AI Auto Edit for many photos, Paste Settings and "Previous" (apply the
 * settings of the previously edited photo).
 */
import type { AppContext } from '@/app/context';
import { applyPrevious, copySettings, pasteSettings as pasteClip } from '@/editor/library';
import { applyPartial } from '@/editor/state';
import { SETTINGS_GROUPS, type EditParams, type PartialParams, type PhotoMeta, type PixelBuffer } from '@/editor/types';
import { reportBatchError } from './dialogs';
import { editPhotos, loadPhotoParams, splitOpenDoc } from './edits';
import { startBatchProgress } from './progress';
import { queueThumbnailRefresh } from './thumbs';

const plural = (n: number): string => `${n} photo${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ */
/* "Previous" tracking                                                 */
/* ------------------------------------------------------------------ */

const previousByCtx = new WeakMap<AppContext, { id: string | null; refs: number; off: () => void }>();

/**
 * Remember which photo was open before the current one (Lightroom's
 * "Previous" source). Ref-counted; returns the stop function.
 */
export function trackPreviousPhoto(ctx: AppContext): () => void {
  let t = previousByCtx.get(ctx);
  if (!t) {
    const rec = { id: null as string | null, refs: 0, off: () => {} };
    rec.off = ctx.doc.subscribe((doc, prev) => {
      if (prev && prev.photoId !== doc?.photoId) rec.id = prev.photoId;
    });
    previousByCtx.set(ctx, rec);
    t = rec;
  }
  t.refs++;
  const tracker = t;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--tracker.refs <= 0) {
      tracker.off();
      previousByCtx.delete(ctx);
    }
  };
}

/** The photo whose settings "Previous" applies: the one open before, else the most recently edited other photo. */
export function findPreviousPhoto(ctx: AppContext, exclude: readonly string[]): string | null {
  const skip = new Set(exclude);
  const tracked = previousByCtx.get(ctx)?.id;
  if (tracked && !skip.has(tracked) && ctx.library.get(tracked)?.hasEdits) return tracked;
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const r of ctx.library.all()) {
    if (skip.has(r.id) || !r.hasEdits) continue;
    const at = r.editedAt ?? 0;
    if (at > bestAt) {
      bestAt = at;
      best = r.id;
    }
  }
  return best;
}

export async function applyPreviousEdit(ctx: AppContext, ids: string[]): Promise<boolean> {
  const targets = ids.filter((id) => ctx.library.get(id));
  if (targets.length === 0) return false;
  const prevId = findPreviousPhoto(ctx, targets);
  if (!prevId) {
    ctx.toast('No previously edited photo to copy from.', 'info');
    return false;
  }
  const prevName = ctx.library.get(prevId)?.name ?? 'previous photo';
  const { docId, others } = splitOpenDoc(ctx, targets);
  const doc = ctx.doc.value;
  if (docId && doc) {
    const source = await loadPhotoParams(ctx, prevId);
    doc.store.replace(pasteClip(doc.store.params, copySettings(source, [...SETTINGS_GROUPS]), { meta: doc.meta }), 'Previous');
    ctx.requestRender();
  }
  const done: string[] = [];
  if (others.length > 0) {
    const prog = startBatchProgress(ctx, 'Applying previous settings');
    try {
      await applyPrevious(ctx.library, prevId, others, undefined, (n, total) => prog.update(n, total), {
        signal: prog.signal,
        onApplied: (id) => done.push(id),
      });
    } catch (err) {
      reportBatchError(ctx, err, 'Previous');
    } finally {
      prog.finish();
    }
  }
  queueThumbnailRefresh(ctx, docId ? [docId, ...done] : done);
  ctx.toast(`Applied the settings of ${prevName} to ${plural((docId ? 1 : 0) + done.length)}.`, 'success');
  return true;
}

/* ------------------------------------------------------------------ */
/* Paste Settings                                                      */
/* ------------------------------------------------------------------ */

export async function pasteSettings(ctx: AppContext, ids: string[]): Promise<boolean> {
  const clip = ctx.settingsClipboard.value;
  if (!clip || clip.groups.length === 0) {
    ctx.toast('Nothing to paste — copy settings first (⇧⌘C).', 'info');
    return false;
  }
  const targets = ids.filter((id) => ctx.library.get(id));
  if (targets.length === 0) return false;
  const prog = targets.length > 3 ? startBatchProgress(ctx, 'Pasting settings') : null;
  try {
    const changed = await editPhotos(ctx, targets, 'Paste Settings', (p, rec) => pasteClip(p, clip, { meta: rec.meta }), {
      signal: prog?.signal,
      onProgress: (n, total) => prog?.update(n, total),
    });
    ctx.toast(changed.length ? `Pasted settings to ${plural(changed.length)}.` : 'Settings already match.', changed.length ? 'success' : 'info');
    return changed.length > 0;
  } catch (err) {
    reportBatchError(ctx, err, 'Paste');
    return false;
  } finally {
    prog?.finish();
  }
}

/* ------------------------------------------------------------------ */
/* AI Auto Edit (batch)                                                */
/* ------------------------------------------------------------------ */

/** Merge an auto edit into existing params: masks are appended, never replacing the user's. */
export function mergeAutoEdit(cur: EditParams, auto: PartialParams): EditParams {
  const { masks, ...rest } = auto;
  let next = applyPartial(cur, rest as PartialParams);
  if (Array.isArray(masks) && masks.length > 0) next = applyPartial(next, { masks: [...next.masks, ...masks] } as PartialParams);
  return next;
}

export interface AutoBatchResult {
  done: number;
  failed: number;
  cancelled: boolean;
}

/**
 * For each photo: decode a ≤1024 px proxy → analyzeImage → generateAutoEdit →
 * merge into the saved edit (the open photo is updated live) → refresh its
 * thumbnail. One decode at a time; cancellable from the progress card.
 */
export async function runAiAutoBatch(ctx: AppContext, ids: string[]): Promise<AutoBatchResult> {
  const targets = ids.filter((id) => ctx.library.get(id));
  const result: AutoBatchResult = { done: 0, failed: 0, cancelled: false };
  if (targets.length === 0) return result;
  let mods: [typeof import('@/editor/io'), typeof import('@/editor/analysis')];
  try {
    mods = await Promise.all([import('@/editor/io'), import('@/editor/analysis')]);
  } catch (err) {
    reportBatchError(ctx, err, 'AI Auto Edit');
    return result;
  }
  const [io, analysis] = mods;
  const prog = startBatchProgress(ctx, 'AI Auto Edit');
  const errors: string[] = [];
  try {
    let i = 0;
    for (const id of targets) {
      if (prog.signal.aborted) break;
      const rec = ctx.library.get(id);
      prog.update(i, targets.length, rec?.name);
      i++;
      if (!rec) continue;
      try {
        const doc = ctx.doc.value;
        let px: PixelBuffer;
        let meta: PhotoMeta;
        if (doc && doc.photoId === id) {
          px = doc.analysisProxy;
          meta = doc.meta;
        } else {
          const file = await ctx.library.getFile(id);
          if (!file) throw new Error('Original file is missing');
          const decoded = await io.decodeFile(file, rec.name, { maxSize: 1024, signal: prog.signal });
          px = decoded.source;
          meta = decoded.meta;
        }
        const report = analysis.analyzeImage(px, meta);
        const auto = analysis.generateAutoEdit(report, meta, { idFactory: () => ctx.newId('mask') });
        await editPhotos(ctx, [id], 'AI Auto Edit', (p) => mergeAutoEdit(p, auto));
        result.done++;
      } catch (err) {
        if (prog.signal.aborted) break;
        result.failed++;
        errors.push(`${rec.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    prog.update(i, targets.length);
  } finally {
    result.cancelled = prog.signal.aborted;
    prog.finish();
  }
  if (errors.length) console.warn('[batch] AI Auto Edit failures', errors);
  const msg = `AI Auto Edit: ${plural(result.done)} edited${result.failed ? `, ${result.failed} failed` : ''}${result.cancelled ? ' (cancelled)' : ''}.`;
  ctx.toast(msg, result.failed ? 'error' : 'success', result.failed ? 6000 : undefined);
  return result;
}
