/**
 * MaskProvider for the engine: cached, incremental mask coverage + change
 * notifications when async inputs (AI bitmaps, depth, source) arrive.
 */
import type { MaskProvider, MaskRasterContext } from '@/editor/contracts';
import type { Mask, MaskBitmap } from '@/editor/types';
import { MaskRasterizer } from './rasterizer';

/** MaskRasterContext + the optional depth request hook (see CONTRACT_CHANGES). */
export interface MaskRasterContextExt extends MaskRasterContext {
  /**
   * Called (once per depth-map identity) when a depth-range component is
   * rasterized while `depth` is missing. The shell should run
   * `segment.estimateDepth(source)` and pass the result via setContext({ depth }).
   */
  requestDepth?: () => void;
}

export interface MaskProviderExt extends MaskProvider {
  setContext(ctx: Partial<MaskRasterContextExt>): void;
  /** Drop every cached plane (e.g. when the photo closes). */
  clear(): void;
  dispose(): void;
}

interface Slot {
  key: string;
  bitmap: MaskBitmap | null;
  /** Ping-pong buffers so a bitmap handed out stays intact until the next-but-one change. */
  buffers: [Uint8Array | null, Uint8Array | null];
  flip: 0 | 1;
}

export function createMaskProvider(initial: MaskRasterContextExt): MaskProviderExt {
  let ctx: MaskRasterContextExt = { ...initial };
  const raster = new MaskRasterizer();
  const listeners = new Set<() => void>();
  const slots = new Map<string, Slot>();
  let depthRequested = false;

  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        console.error('[masks] MaskProvider listener failed', e);
      }
    }
  };

  const onAi = (key: string) => {
    raster.resetRequested(key);
    if (raster.usedAiKeys.has(key)) notify();
  };
  let unsubAi = ctx.aiStore.onChange(onAi);

  return {
    getMask(mask: Mask, width: number, height: number): MaskBitmap | null {
      const r = raster.rasterize(mask, ctx, width, height);
      if (raster.usesDepth && !ctx.depth && !depthRequested && ctx.requestDepth) {
        depthRequested = true;
        ctx.requestDepth();
      }
      let slot = slots.get(mask.id);
      if (slot && slot.key === r.key) return slot.bitmap;
      if (!slot) {
        slot = { key: '', bitmap: null, buffers: [null, null], flip: 0 };
        slots.set(mask.id, slot);
      }
      slot.key = r.key;
      if (r.empty) {
        slot.bitmap = null;
        return null;
      }
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      slot.flip = slot.flip === 0 ? 1 : 0;
      let buf = slot.buffers[slot.flip];
      if (!buf || buf.length !== w * h) buf = slot.buffers[slot.flip] = new Uint8Array(w * h);
      buf.set(r.data);
      slot.bitmap = { width: w, height: h, data: buf, key: r.key };
      return slot.bitmap;
    },
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setContext(patch: Partial<MaskRasterContextExt>): void {
      const prev = ctx;
      ctx = { ...ctx, ...patch };
      let changed = false;
      if (patch.aiStore && patch.aiStore !== prev.aiStore) {
        unsubAi();
        unsubAi = ctx.aiStore.onChange(onAi);
        raster.resetRequested();
        changed = raster.usedAiKeys.size > 0;
      }
      if ('requestAi' in patch && patch.requestAi !== prev.requestAi) raster.resetRequested();
      if ('depth' in patch && patch.depth !== prev.depth) {
        depthRequested = false;
        changed ||= raster.usesDepth;
      }
      if (patch.source && patch.source !== prev.source) {
        changed ||= raster.usesSource;
        // New photo / proxy: depth belongs to the old source unless supplied too.
        if (!('depth' in patch)) depthRequested = false;
      }
      if (changed) notify();
    },
    clear(): void {
      raster.clear();
      slots.clear();
      raster.usedAiKeys.clear();
      raster.usesDepth = false;
      raster.usesSource = false;
      raster.resetRequested();
      depthRequested = false;
    },
    dispose(): void {
      unsubAi();
      listeners.clear();
      raster.clear();
      slots.clear();
    },
  };
}
