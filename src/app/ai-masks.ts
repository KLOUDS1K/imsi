/**
 * AI mask coordination: turns the mask rasterizer's `requestAi(componentId,
 * target)` callbacks into background segmentation jobs, and estimates a depth
 * map when a depth-range component appears.
 *
 * Flow: the engine asks the MaskProvider for coverage → the rasterizer finds an
 * 'ai' component whose bitmap is missing → requestAi → (IndexedDB cache →)
 * segment.segment(target, doc.analysisProxy, {point|box}) → aiMaskStore.set →
 * the provider notices the store change → re-render.
 *
 * Bitmap keys are deterministic (photo + target + point/box), so undo/redo and
 * reopening a photo hit the cache instead of recomputing. When a component has
 * no `bitmapKey` yet, the key is written into the params as a transient change
 * (no history step; autosave persists it).
 *
 * Depth: `segment.estimateDepth` runs once per opened photo when needed; the
 * map is handed to the provider (MaskRasterContext.depth) and also published in
 * the AI mask store under `depthKey(photoId)` so the viewer can read the depth
 * at a clicked point.
 */
import type { AiMaskParams, AiMaskTarget, EditParams, MaskBitmap, MaskComponent } from '@/editor/types';
import type { AppContext, EditorDocument } from './context';
import type { FeatureRegistry } from './modules';
import type { PersistentAiMaskStore } from './services';
import type { BusyTracker } from './busy';

export const depthKey = (photoId: string): string => `depth:${photoId}`;
export const AI_MASK_CACHE_VERSION = 'v2';

/** FNV-1a 32-bit → base36 (stable short hash for cache keys). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function aiBitmapKey(photoId: string, ai: Pick<AiMaskParams, 'target' | 'point' | 'box'>): string {
  const r = (v: number): string => v.toFixed(4);
  const geo = ai.point ? `p${r(ai.point.x)},${r(ai.point.y)}` : ai.box ? `b${r(ai.box.x)},${r(ai.box.y)},${r(ai.box.w)},${r(ai.box.h)}` : '';
  return `ai:${AI_MASK_CACHE_VERSION}:${photoId}:${ai.target}:${hashString(geo)}`;
}

export const isCurrentAiBitmapKey = (key: string | undefined): key is string => !!key && key.startsWith(`ai:${AI_MASK_CACHE_VERSION}:`);

/** Every AI bitmap key referenced by the params (for restore on open). */
export function aiKeysOf(params: EditParams): string[] {
  const keys: string[] = [];
  for (const m of params.masks) for (const c of m.components) if (isCurrentAiBitmapKey(c.ai?.bitmapKey)) keys.push(c.ai.bitmapKey);
  return keys;
}

export function patchKeysOf(params: EditParams): string[] {
  return params.retouch.removals.map((r) => r.patchKey).filter(Boolean);
}

export function needsDepth(params: EditParams): boolean {
  return params.masks.some((m) => m.components.some((c) => c.kind === 'depth-range'));
}

function findComponent(params: EditParams, id: string): { mi: number; ci: number; comp: MaskComponent } | null {
  for (let mi = 0; mi < params.masks.length; mi++) {
    const comps = params.masks[mi].components;
    for (let ci = 0; ci < comps.length; ci++) if (comps[ci].id === id) return { mi, ci, comp: comps[ci] };
  }
  return null;
}

export interface AiMaskCoordinator {
  requestAi(componentId: string, target: AiMaskTarget): void;
  /** Start depth estimation for the doc if a depth-range component needs it. */
  checkDepth(doc: EditorDocument): void;
  /** The current doc's depth map, if estimated. */
  depth(): MaskBitmap | null;
  /** Cancel jobs of the previous photo (call on doc switch). */
  reset(): void;
  dispose(): void;
}

export interface AiMaskCoordinatorDeps {
  ctx: AppContext;
  features: FeatureRegistry;
  store: PersistentAiMaskStore;
  busy: BusyTracker;
  /** A new depth map is available for the open photo. */
  onDepth(depth: MaskBitmap | null): void;
}

export function createAiMaskCoordinator(deps: AiMaskCoordinatorDeps): AiMaskCoordinator {
  const { ctx, features, store, busy } = deps;
  const inflight = new Set<string>();
  const failed = new Set<string>();
  let abort = new AbortController();
  let depthFor: string | null = null;
  let depthMap: MaskBitmap | null = null;
  let depthJob: string | null = null;

  const labelFor = (t: AiMaskTarget): string => (t === 'object' ? 'object' : t);

  async function compute(doc: EditorDocument, key: string, ai: AiMaskParams, signal: AbortSignal): Promise<void> {
    // 1. IndexedDB cache (bitmap computed in an earlier session).
    await store.restore([key]);
    if (store.get(key) || signal.aborted) return;
    // 2. Segmentation in the background.
    const segment = await features.load('segment');
    if (!segment) {
      if (!failed.has('segment')) {
        failed.add('segment');
        ctx.toast('AI masks are unavailable: the segmentation module could not be loaded.', 'error');
      }
      return;
    }
    const task = busy.begin(`Detecting ${labelFor(ai.target)}…`);
    try {
      const bmp = await segment.segment(ai.target, doc.analysisProxy, { point: ai.point, box: ai.box, signal });
      if (signal.aborted || ctx.doc.value !== doc) return;
      store.set(key, { ...bmp, key });
    } finally {
      task.end();
    }
  }

  return {
    requestAi(componentId, target) {
      const doc = ctx.doc.value;
      if (!doc) return;
      const found = findComponent(doc.store.params, componentId);
      if (!found || !found.comp.ai) return;
      const ai = found.comp.ai;
      const currentKey = isCurrentAiBitmapKey(ai.bitmapKey);
      const key: string = currentKey ? ai.bitmapKey! : aiBitmapKey(doc.photoId, { target, point: ai.point, box: ai.box });
      if (!currentKey) {
        // A missing key means an explicit Refresh; an old key means the mask
        // was made by the previous detector. Either case must be allowed to retry.
        failed.delete(key);
        // Deferred: requestAi is called from inside a render; never mutate the store re-entrantly.
        setTimeout(() => {
          if (ctx.doc.value !== doc) return;
          const again = findComponent(doc.store.params, componentId);
          if (again?.comp.ai && !isCurrentAiBitmapKey(again.comp.ai.bitmapKey)) doc.store.set(`masks.${again.mi}.components.${again.ci}.ai.bitmapKey`, key, { transient: true });
        }, 0);
      }
      if (store.get(key) || inflight.has(key) || failed.has(key)) return;
      inflight.add(key);
      const signal = abort.signal;
      compute(doc, key, { ...ai, target }, signal)
        .catch((err: unknown) => {
          if (signal.aborted) return;
          failed.add(key);
          console.error('[kloud] AI mask failed', err);
          ctx.toast(`Could not detect ${labelFor(target)}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        })
        .finally(() => inflight.delete(key));
    },

    checkDepth(doc) {
      if (depthFor === doc.photoId && (depthMap || depthJob)) return;
      if (!needsDepth(doc.store.params)) return;
      const key = depthKey(doc.photoId);
      depthFor = doc.photoId;
      const cached = store.get(key);
      if (cached) {
        depthMap = cached;
        deps.onDepth(cached);
        return;
      }
      depthJob = key;
      const signal = abort.signal;
      void (async () => {
        const segment = await features.load('segment');
        if (!segment || signal.aborted) return;
        const task = busy.begin('Estimating depth…');
        try {
          const bmp = await segment.estimateDepth(doc.analysisProxy);
          if (signal.aborted || ctx.doc.value !== doc) return;
          depthMap = { ...bmp, key };
          // Depth maps are cheap to recompute: keep them out of IndexedDB.
          store.setVolatile(key, depthMap);
          deps.onDepth(depthMap);
        } catch (err) {
          if (!signal.aborted) {
            console.error('[kloud] depth estimation failed', err);
            ctx.toast('Depth estimation failed; depth-range masks stay empty.', 'error');
          }
        } finally {
          task.end();
          if (depthJob === key) depthJob = null;
        }
      })();
    },

    depth: () => depthMap,

    reset() {
      abort.abort();
      abort = new AbortController();
      inflight.clear();
      failed.clear();
      depthFor = null;
      depthMap = null;
      depthJob = null;
    },

    dispose() {
      abort.abort();
    },
  };
}
