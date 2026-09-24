/**
 * masks/ — mask rasterization in SOURCE space (coverage 0..255).
 *
 *   import { createMaskProvider, createAiMaskStore } from '@/editor/masks';
 *   const aiStore = createAiMaskStore();
 *   const provider = createMaskProvider({ source: proxy, aiStore, requestAi, requestDepth });
 *   engine.setMaskProvider(provider);
 *
 * Components combine in order: the first is always 'add'; add = screen union
 * (a + b − ab), subtract = a·(1 − b), intersect = a·b; each component may be
 * inverted, then `mask.invert` inverts the result.
 */
import type { MaskRasterContext, MasksModule } from '@/editor/contracts';
import type { AiMaskTarget, BrushStroke, Mask, Rect } from '@/editor/types';
import { MaskRasterizer } from './rasterizer';
import { createMaskProvider } from './provider';
import { createAiMaskStore } from './store';
import { rasterizeStrokes as rasterizeStrokesImpl, strokesBounds as strokesBoundsImpl } from './brush';

export { createMaskProvider } from './provider';
export type { MaskProviderExt, MaskRasterContextExt } from './provider';
export { createAiMaskStore, serializeMaskBitmap, deserializeMaskBitmap } from './store';
export type { AiMaskBacking, AiMaskStoreExt } from './store';
export { BrushRaster, DAB_SPACING } from './brush';
export { MaskRasterizer } from './rasterizer';
export { colorRangeThreshold, COLOR_RANGE_L_WEIGHT, rangeValue } from './components';
export { srgbToOklab, lstarFromY } from './source';

/** Shared cache for the pure rasterizeMask() (bounded; separate from any provider). */
let shared: MaskRasterizer | null = null;

/** Coverage 0..255 (fresh array, width×height, SOURCE space). */
export function rasterizeMask(mask: Mask, ctx: MaskRasterContext, width: number, height: number): Uint8Array {
  shared ??= new MaskRasterizer({ budget: 64 * 1024 * 1024, maxBrushStates: 1 });
  return shared.rasterize(mask, ctx, width, height).data.slice();
}

/** Stroke rasterization shared with heal/removal (coverage 0..255). */
export function rasterizeStrokes(strokes: BrushStroke[], width: number, height: number): Uint8Array {
  return rasterizeStrokesImpl(strokes, width, height);
}

/**
 * Bounding box (source-normalized) of strokes incl. brush size. Pass the
 * source aspect (width / height) for an exact box on non-square images.
 */
export function strokesBounds(strokes: BrushStroke[], aspect?: number): Rect {
  return strokesBoundsImpl(strokes, aspect);
}

/** What asynchronous inputs a mask needs (lets the shell prefetch depth / AI masks). */
export function maskDependencies(mask: Mask): {
  ai: { componentId: string; target: AiMaskTarget; bitmapKey?: string }[];
  depth: boolean;
  source: boolean;
} {
  const ai: { componentId: string; target: AiMaskTarget; bitmapKey?: string }[] = [];
  let depth = false;
  let source = false;
  for (const c of mask.components) {
    if (c.kind === 'ai' && c.ai) ai.push({ componentId: c.id, target: c.ai.target, bitmapKey: c.ai.bitmapKey });
    else if (c.kind === 'depth-range') depth = true;
    else if (c.kind === 'color-range' || c.kind === 'luminance-range') source = true;
  }
  return { ai, depth, source };
}

export const masksModule = {
  rasterizeMask,
  createMaskProvider,
  createAiMaskStore,
  rasterizeStrokes,
  strokesBounds,
} satisfies MasksModule;
