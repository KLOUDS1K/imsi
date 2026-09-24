/**
 * The single rAF render scheduler.
 *
 * Every change that affects the picture (params, preview params, tool, view,
 * masks, patches, theme) calls `request()`; at most one frame runs per
 * animation frame and it only re-runs the parts that changed:
 *
 *   main slot    ← params (previewParams ?? store.params), quality, crop tool
 *   compare slot ← only while a compare layout needs it
 *   present      ← every frame (cheap: composites the slots with the view)
 *
 * Progressive rendering: while the store is inside a gesture (slider drag,
 * wheel/keyboard burst) the main slot renders in 'draft' quality; 150 ms after
 * the last change a 'full' render follows automatically, so holding a slider
 * still also sharpens the preview.
 *
 * Before/after alignment (decision): the 'compare' slot renders the "before"
 * params (ctx.compareParams, or the photo defaults = "original") with the
 * CURRENT geometry — crop, transform and the geometric part of the lens
 * correction — exactly like Lightroom, which shows the before state with the
 * current crop. That keeps split / side-by-side views pixel-aligned.
 *
 * The histogram is read back (engine.readPixels(256) → computeHistogram) after
 * full renders and, throttled, during drags.
 */
import type { AnalysisModule, CompareMode } from '@/editor/contracts';
import type { EditParams } from '@/editor/types';
import { createDefaultParams } from '@/editor/defaults';
import type { AppContext, EditorDocument } from './context';

const FULL_AFTER_MS = 150;
const HISTOGRAM_FULL_MS = 120;
const HISTOGRAM_DRAFT_MS = 350;
const COMPARE_MODES: ReadonlySet<CompareMode> = new Set<CompareMode>(['before', 'side-by-side', 'split-vertical', 'split-horizontal']);

export interface RenderLoopDeps {
  analysis(): AnalysisModule | null;
  /** Called after each main-slot render with its timing. */
  onStats?(stats: { ms: number; quality: 'draft' | 'full' }): void;
  onError?(err: unknown): void;
}

export interface RenderLoop {
  /** Schedule a frame (coalesced to one per animation frame). */
  request(): void;
  /** Force the main (and compare) slots to re-render on the next frame (source/mask/patch changes). */
  invalidate(): void;
  /** Render synchronously now (tests / before readbacks). */
  flushNow(): void;
  dispose(): void;
}

interface SlotKey {
  doc: EditorDocument | null;
  params: EditParams | null;
  quality: 'draft' | 'full' | null;
  ignoreCrop: boolean;
  version: number;
  detail: boolean;
}

const emptyKey = (): SlotKey => ({ doc: null, params: null, quality: null, ignoreCrop: false, version: -1, detail: false });

/**
 * Does the current zoom show more device pixels per image pixel than the
 * preview proxy has? Then a full-resolution ("detail") render is worth it.
 */
function needsDetail(engine: NonNullable<AppContext['engine']>, doc: EditorDocument, view: AppContext['view']['value']): boolean {
  const src = doc.source;
  if (view.zoom === 'fit' || !(src.fullWidth > src.width * 1.15)) return false;
  const t = engine.getDisplayTransform(view);
  const dpr = globalThis.devicePixelRatio || 1;
  return t.scale * dpr > (src.width / src.fullWidth) * 1.15;
}

/**
 * "Before" params that share the current geometry. Geometric lens fields are
 * copied; when the before state had no profile enabled, the profile's
 * vignetting correction is scaled to 0 so only its distortion is applied.
 */
export function alignBeforeParams(before: EditParams, current: EditParams): EditParams {
  const lens = { ...before.lens };
  lens.distortion = current.lens.distortion;
  lens.removeCA = current.lens.removeCA;
  if (current.lens.profileEnabled) {
    if (!before.lens.profileEnabled) lens.profileVignettingScale = 0;
    lens.profileEnabled = true;
    lens.profileId = current.lens.profileId;
    lens.profileDistortionScale = current.lens.profileDistortionScale;
  } else {
    lens.profileEnabled = false;
  }
  return { ...before, crop: current.crop, transform: current.transform, lens };
}

export function createRenderLoop(ctx: AppContext, deps: RenderLoopDeps): RenderLoop {
  let raf = 0;
  let disposed = false;
  let version = 0;
  let main = emptyKey();
  let compare = emptyKey();
  let fullTimer: ReturnType<typeof setTimeout> | null = null;
  let histTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHistAt = 0;
  let lastChangeAt = 0;
  let errorReported = false;
  /** Photo whose full-resolution source the engine currently holds / is loading. */
  let detailDoc: EditorDocument | null = null;
  let detailLoading: EditorDocument | null = null;
  /** Memo for the aligned "before" params (avoid re-rendering compare when nothing changed). */
  let beforeMemo: { src: EditParams | null; cur: EditParams; isRaw: boolean; out: EditParams } | null = null;

  const request = (): void => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(frame);
  };

  const scheduleFull = (): void => {
    if (fullTimer) clearTimeout(fullTimer);
    fullTimer = setTimeout(() => {
      fullTimer = null;
      request();
    }, FULL_AFTER_MS);
  };

  const scheduleHistogram = (quality: 'draft' | 'full'): void => {
    const analysis = deps.analysis();
    if (!analysis || histTimer) return;
    const minGap = quality === 'full' ? HISTOGRAM_FULL_MS : HISTOGRAM_DRAFT_MS;
    const wait = Math.max(0, lastHistAt + minGap - performance.now());
    histTimer = setTimeout(() => {
      histTimer = null;
      const engine = ctx.engine;
      if (disposed || !engine || !ctx.doc.value) return;
      try {
        lastHistAt = performance.now();
        const px = engine.readPixels(256, 'main');
        ctx.histogram.set(analysis.computeHistogram(px));
      } catch (err) {
        console.warn('[kloud] histogram update failed', err);
      }
    }, wait);
  };

  const beforeParams = (doc: EditorDocument, current: EditParams): EditParams => {
    const src = ctx.compareParams.value;
    if (beforeMemo && beforeMemo.src === src && beforeMemo.cur === current && beforeMemo.isRaw === doc.isRaw) return beforeMemo.out;
    const base = src ?? createDefaultParams(doc.isRaw);
    // Reuse the previous output when only non-geometric params changed, so the compare slot stays cached.
    const prev = beforeMemo;
    if (
      prev &&
      prev.src === src &&
      prev.isRaw === doc.isRaw &&
      prev.cur.crop === current.crop &&
      prev.cur.transform === current.transform &&
      prev.cur.lens === current.lens
    ) {
      beforeMemo = { ...prev, cur: current };
      return prev.out;
    }
    const out = alignBeforeParams(base, current);
    beforeMemo = { src, cur: current, isRaw: doc.isRaw, out };
    return out;
  };

  function frame(): void {
    raf = 0;
    if (disposed) return;
    const engine = ctx.engine;
    const doc = ctx.doc.value;
    if (!engine) return;
    if (!doc) {
      main = emptyKey();
      compare = emptyKey();
      return;
    }
    try {
      const params = ctx.previewParams.value ?? doc.store.params;
      const ignoreCrop = ctx.tool.value === 'crop';
      const interactive = doc.store.gestureActive;
      const now = performance.now();
      const changed = main.doc !== doc || main.params !== params || main.ignoreCrop !== ignoreCrop || main.version !== version;
      if (changed) lastChangeAt = now;
      // Draft only while a gesture is producing changes; once it has been still for
      // FULL_AFTER_MS (or the gesture ended) the same params render in full quality.
      const quality: 'draft' | 'full' = interactive && now - lastChangeAt < FULL_AFTER_MS - 8 ? 'draft' : 'full';
      const view = ctx.view.value;

      // Full-resolution detail when zoomed in past the proxy (loaded once per photo, in the background).
      if (detailDoc && detailDoc !== doc) {
        engine.setDetailSource?.(null);
        detailDoc = null;
      }
      let detail = false;
      if (quality === 'full' && engine.setDetailSource && needsDetail(engine, doc, view)) {
        if (detailDoc === doc) detail = true;
        else if (detailLoading !== doc) {
          detailLoading = doc;
          void doc.decoded
            .loadFull()
            .then((full) => {
              if (disposed || ctx.doc.value !== doc) return;
              engine.setDetailSource?.(full);
              detailDoc = doc;
              request();
            })
            .catch((err: unknown) => console.warn('[kloud] full-resolution decode failed', err))
            .finally(() => {
              if (detailLoading === doc) detailLoading = null;
            });
        }
      }

      if (changed || (main.quality === 'draft' && quality === 'full') || main.detail !== detail) {
        const t0 = performance.now();
        engine.render(params, { target: 'main', quality, ignoreCrop, detail });
        const ms = performance.now() - t0;
        main = { doc, params, quality, ignoreCrop, version, detail };
        deps.onStats?.({ ms, quality });
        scheduleHistogram(quality);
      }
      if (quality === 'draft') scheduleFull();

      if (COMPARE_MODES.has(view.compare)) {
        const before = beforeParams(doc, params);
        const cq: 'draft' | 'full' = quality;
        const compareStale =
          compare.doc !== doc ||
          compare.params !== before ||
          compare.ignoreCrop !== ignoreCrop ||
          compare.version !== version ||
          (compare.quality === 'draft' && cq === 'full');
        if (compareStale) {
          engine.render(before, { target: 'compare', quality: cq, ignoreCrop });
          compare = { doc, params: before, quality: cq, ignoreCrop, version, detail: false };
        }
      }

      engine.present(view);
      errorReported = false;
    } catch (err) {
      // Report once per failure streak; a broken pass must not spam toasts at 60 fps.
      if (!errorReported) {
        errorReported = true;
        console.error('[kloud] render failed', err);
        deps.onError?.(err);
      }
    }
  }

  return {
    request,
    invalidate() {
      version++;
      request();
    },
    flushNow() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      frame();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (fullTimer) clearTimeout(fullTimer);
      if (histTimer) clearTimeout(histTimer);
      fullTimer = histTimer = null;
    },
  };
}
