/**
 * Document lifecycle: open / switch / close photos in Develop.
 *
 * openPhoto(id)
 *   1. flush the current photo's autosave (it stays on screen while the next decodes)
 *   2. library.getFile → io.decodeFile(maxSize = preview limit, progress in ctx.busy)
 *   3. saved edit (library.loadEdit) or defaults + auto-apply conditional presets
 *   4. EditorStore, 8-bit analysis proxy (≤ 1024 px)
 *   5. restore the AI mask bitmaps / removal patches the edit references
 *   6. finalize the previous photo (style feedback, thumbnail, clean autosave)
 *   7. engine.setSource → ctx.doc.set → render
 * Opening is cancellable: a newer openPhoto() aborts the decode of an older one.
 *
 * While a photo is open, every store change schedules the render; settled
 * (non-interactive) changes also schedule the autosave and a debounced
 * thumbnail refresh (engine.renderThumbnail → library.setThumbnail).
 */
import type { EditParams } from '@/editor/types';
import { createDefaultParams } from '@/editor/defaults';
import { EditorStore } from '@/editor/state';
import { applyPreset, matchConditionalPresets } from '@/editor/presets';
import type { AutosaveManager } from '@/editor/storage';
import type { Signal } from '@/ui/signal';
import type { AppContext, EditorDocument } from './context';
import type { FeatureRegistry } from './modules';
import type { PersistentAiMaskStore, PersistentPatchStore } from './services';
import type { RenderLoop } from './render-loop';
import type { BusyTracker } from './busy';
import { aiKeysOf, needsDepth, patchKeysOf, type AiMaskCoordinator } from './ai-masks';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

const ANALYSIS_PROXY = 1024;
const THUMB_SIZE = 320;
const THUMB_DEBOUNCE_MS = 1800;

export interface DocumentControllerDeps {
  ctx: AppContext;
  features: FeatureRegistry;
  autosave: AutosaveManager;
  render: RenderLoop;
  busy: BusyTracker;
  aiMasks: PersistentAiMaskStore;
  patches: PersistentPatchStore;
  ai: AiMaskCoordinator;
  /** Point the mask provider at the new photo (analysis proxy, depth). */
  onDocChange(doc: EditorDocument | null): void;
  saveState: Signal<SaveState>;
  lastOpenedId: Signal<string | null>;
  previewMaxSize: number;
}

export interface DocumentController {
  open(id: string): Promise<void>;
  close(): void;
  /** Persist the open photo now. */
  save(): Promise<void>;
  /** Open the neighbour in ctx.visibleIds (delta ±1). Returns false at the ends. */
  step(delta: number): boolean;
  /** Finalize without switching (page unload). */
  flushAll(): Promise<void>;
  dispose(): void;
}

export function createDocumentController(deps: DocumentControllerDeps): DocumentController {
  const { ctx, features, autosave, render, busy } = deps;
  let seq = 0;
  let abort: AbortController | null = null;
  let detachStore: (() => void) | null = null;
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  let thumbDirty = false;
  let disposed = false;

  const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /* ---------------- thumbnails ---------------- */

  async function refreshThumbnail(doc: EditorDocument): Promise<void> {
    if (thumbTimer) {
      clearTimeout(thumbTimer);
      thumbTimer = null;
    }
    const engine = ctx.engine;
    if (!thumbDirty || !engine || engine.getSource() !== doc.source) return;
    thumbDirty = false;
    try {
      const blob = await engine.renderThumbnail(doc.store.params, THUMB_SIZE);
      await ctx.library.setThumbnail(doc.photoId, blob);
    } catch (err) {
      console.warn('[kloud] thumbnail update failed', err);
    }
  }

  function scheduleThumbnail(doc: EditorDocument): void {
    thumbDirty = true;
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      thumbTimer = null;
      if (ctx.doc.value === doc) void refreshThumbnail(doc);
    }, THUMB_DEBOUNCE_MS);
  }

  /* ---------------- store wiring ---------------- */

  function schedulePersist(doc: EditorDocument): void {
    autosave.schedule(doc.photoId, doc.store.serialize());
    deps.saveState.set('pending');
  }

  function attach(doc: EditorDocument): void {
    detachStore?.();
    detachStore = doc.store.subscribe((params, info) => {
      const paramsChanged = info.paths.length > 0;
      if (paramsChanged) render.request();
      // Autosave/thumbnail once a gesture settles; drags only render.
      if (info.interactive) return;
      schedulePersist(doc);
      if (paramsChanged) {
        scheduleThumbnail(doc);
        if (needsDepth(params)) deps.ai.checkDepth(doc);
      }
    });
  }

  /** Style feedback, pending thumbnail, final autosave for the photo being left. */
  async function finalize(doc: EditorDocument): Promise<void> {
    detachStore?.();
    detachStore = null;
    const panels = features.get('panels') as { recordStyleFeedback?: (c: AppContext) => unknown } | null;
    if (panels && typeof panels.recordStyleFeedback === 'function') {
      try {
        await panels.recordStyleFeedback(ctx);
      } catch (err) {
        console.warn('[kloud] style feedback failed', err);
      }
    }
    await refreshThumbnail(doc);
    try {
      deps.saveState.set('saving');
      await autosave.markClean();
      deps.saveState.set('saved');
    } catch (err) {
      deps.saveState.set('error');
      ctx.toast(`Could not save edits to ${doc.record.name}: ${errorMessage(err)}`, 'error');
    }
  }

  /* ---------------- open ---------------- */

  function initialParams(isRaw: boolean, doc: Pick<EditorDocument, 'meta'>): { params: EditParams; label: string | null } {
    let params = createDefaultParams(isRaw);
    const auto = matchConditionalPresets(ctx.presets.value, doc.meta).filter((p) => p.conditions?.autoApply);
    if (!auto.length) return { params, label: null };
    for (const p of auto) params = applyPreset(params, p, 100);
    return { params, label: `Auto preset: ${auto.map((p) => p.name).join(', ')}` };
  }

  async function open(id: string): Promise<void> {
    if (disposed) return;
    const record = ctx.library.get(id);
    if (!record) {
      ctx.toast('That photo is no longer in the library.', 'error');
      return;
    }
    const current = ctx.doc.value;
    if (current?.photoId === id) {
      deps.lastOpenedId.set(id);
      return;
    }
    const mySeq = ++seq;
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    const stale = (): boolean => mySeq !== seq || disposed;
    const task = busy.begin(`Opening ${record.name}`, 0);
    try {
      // Persist the photo on screen first; it stays visible until the next one is ready.
      await autosave.flush().catch(() => undefined);
      const io = await features.load('io');
      if (!io) throw new Error('the image decoder module is not available');
      const file = await ctx.library.getFile(id);
      if (!file) throw new Error('the original file is missing from the library');
      if (stale()) return;
      const decoded = await io.decodeFile(file, record.name, {
        maxSize: deps.previewMaxSize,
        signal: ac.signal,
        onProgress: (f, stage) => task.update(Math.max(0, Math.min(1, f)) * 0.9, `${stageLabel(stage)} ${record.name}`),
      });
      if (stale()) return;
      const isRaw = decoded.source.isRaw;
      const saved = await ctx.library.loadEdit(id);
      const store = new EditorStore(undefined, { isRaw });
      let autoLabel: string | null = null;
      if (saved) store.load(saved);
      else {
        const init = initialParams(isRaw, decoded);
        if (init.label) {
          store.replace(init.params, init.label);
          autoLabel = init.label;
        }
      }
      task.update(0.93, `Preparing ${record.name}`);
      const analysisProxy = io.toSrgb8(io.downscale(decoded.source, ANALYSIS_PROXY));
      await Promise.all([deps.aiMasks.restore(aiKeysOf(store.params)), deps.patches.restore(patchKeysOf(store.params))]);
      if (stale()) return;

      // Leave the previous photo (needs the old source on the GPU for its thumbnail).
      if (current) await finalize(current);
      if (stale()) return;
      deps.ai.reset();
      features.get('geometry')?.setGeometryMeta(decoded.meta);
      if (ctx.engine) {
        try {
          await ctx.engine.setSource(decoded.source);
        } catch (err) {
          throw new Error(`the renderer could not load the image (${errorMessage(err)})`);
        }
      }
      if (stale()) return;

      const doc: EditorDocument = {
        photoId: id,
        record: ctx.library.get(id) ?? record,
        meta: decoded.meta,
        decoded,
        source: decoded.source,
        analysisProxy,
        store,
        isRaw,
      };
      attach(doc);
      thumbDirty = false;
      ctx.previewParams.set(null);
      ctx.compareParams.set(null);
      ctx.activeMaskId.set(null);
      ctx.histogram.set(null);
      ctx.pixelReadout.set(null);
      ctx.wbPickerActive.set(false);
      ctx.view.set({ ...ctx.view.value, center: { x: 0.5, y: 0.5 }, maskOverlay: null });
      deps.onDocChange(doc);
      ctx.doc.set(doc);
      // Make the opened photo the "most selected" one without dropping a multi-selection.
      const sel = ctx.selection.value;
      ctx.selection.set(sel.includes(id) ? [id, ...sel.filter((x) => x !== id)] : [id]);
      deps.lastOpenedId.set(id);
      deps.saveState.set(saved ? 'saved' : 'idle');
      if (autoLabel) {
        schedulePersist(doc);
        scheduleThumbnail(doc);
        ctx.toast(autoLabel, 'info', 2500);
      }
      if (needsDepth(store.params)) deps.ai.checkDepth(doc);
      render.invalidate();
    } catch (err) {
      if (ac.signal.aborted || stale()) return;
      console.error('[kloud] open failed', err);
      ctx.toast(`Could not open ${record.name}: ${errorMessage(err)}`, 'error', 6000);
    } finally {
      task.end();
      if (abort === ac) abort = null;
    }
  }

  function close(): void {
    const doc = ctx.doc.value;
    seq++;
    abort?.abort();
    abort = null;
    if (!doc) return;
    // Clear the doc first so nothing renders/edits it any more; persist in the background.
    const pending = finalize(doc);
    deps.ai.reset();
    deps.onDocChange(null);
    ctx.previewParams.set(null);
    ctx.compareParams.set(null);
    ctx.histogram.set(null);
    ctx.doc.set(null);
    features.get('geometry')?.setGeometryMeta(null);
    void pending;
  }

  function step(delta: number): boolean {
    const ids = ctx.visibleIds.value;
    if (!ids.length) return false;
    const cur = ctx.doc.value?.photoId ?? ctx.selection.value[0];
    const i = cur ? ids.indexOf(cur) : -1;
    const next = i < 0 ? ids[0] : ids[i + delta];
    if (!next) return false;
    void open(next);
    return true;
  }

  return {
    open,
    close,
    step,
    async save() {
      const doc = ctx.doc.value;
      if (!doc) return;
      deps.saveState.set('saving');
      try {
        autosave.schedule(doc.photoId, doc.store.serialize());
        await autosave.flush();
        deps.saveState.set('saved');
      } catch (err) {
        deps.saveState.set('error');
        throw err;
      }
    },
    async flushAll() {
      const doc = ctx.doc.value;
      if (doc && doc.store.gestureActive) doc.store.endGesture();
      await autosave.markClean();
    },
    dispose() {
      disposed = true;
      abort?.abort();
      detachStore?.();
      if (thumbTimer) clearTimeout(thumbTimer);
    },
  };
}

function stageLabel(stage: string): string {
  const s = stage.toLowerCase();
  if (s.includes('raw') || s.includes('demosaic')) return 'Developing RAW';
  if (s.includes('read') || s.includes('load')) return 'Reading';
  return 'Decoding';
}
