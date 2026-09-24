/**
 * ai/inpaint — "AI Object Removal", "Generative Remove", "Content-Aware Heal"
 * and "Dust Removal".
 *
 * Honest labelling: everything here is classical image processing (PatchMatch
 * exemplar inpainting, texture synthesis by a sharp patch vote, SSD-based heal
 * source search). No trained generative model is involved; INPAINT_KIND_INFO
 * carries the wording for UI badges / tooltips.
 *
 * Usage notes
 * - inpaint() and createRemovalPatch() run the heavy work in a Web Worker
 *   (one per job; aborting terminates it) and fall back to the calling thread
 *   where Workers are unavailable.
 * - Patch pixels are RGBA8 sRGB covering RemovalPatch.bbox exactly (alpha =
 *   feathered stroke coverage). Store them in createPatchStore() under
 *   patch.patchKey and hand the store to engine.setPatchProvider(). Persist
 *   with serializePatch()/deserializePatch() (storage 'patches').
 * - findHealSource / dustToSpots are synchronous and cheap (they only read a
 *   small window around each spot).
 */
import type { InpaintModule, InpaintOptions } from '@/editor/contracts';
import type { PixelBuffer, PixelBufferU8 } from '@/editor/types';
import { runInpaintJob } from './client';
import { dustToSpots, findHealSource } from './heal-source';
import { createPatchStore } from './patch-store';
import { readRgba8 } from './pixels';
import { createRemovalPatch } from './removal';

export { createRemovalPatch, INPAINT_KIND_INFO, type RemovalKindInfo } from './removal';
export { dustToSpots, findHealSource } from './heal-source';
export { createPatchStore, deserializePatch, serializePatch, type PatchStore } from './patch-store';
export { DEFAULT_PM_OPTIONS, InpaintAbortError, inpaintRgba8, type PatchMatchOptions } from './patchmatch';

/**
 * Fill the masked region (mask 0..255, same size as px; 255 = fully replaced,
 * intermediate values blend). Unmasked pixels are returned unchanged.
 */
export async function inpaint(px: PixelBuffer, mask: Uint8Array, opts: InpaintOptions = {}): Promise<PixelBufferU8> {
  const { width, height } = px;
  if (mask.length < width * height) throw new Error('inpaint: mask must be width×height bytes');
  const rgba = readRgba8(px);
  const data = await runInpaintJob(
    rgba,
    width,
    height,
    mask,
    { patchSize: opts.patchSize, iterations: opts.iterations },
    { signal: opts.signal, onProgress: opts.onProgress },
  );
  return { width, height, data, transfer: 'srgb' };
}

export const inpaintModule = {
  inpaint,
  findHealSource,
  createRemovalPatch,
  dustToSpots,
  createPatchStore,
} satisfies InpaintModule;
