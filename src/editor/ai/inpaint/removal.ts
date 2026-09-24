/**
 * Brush strokes → RemovalPatch (+ its pixels).
 *
 * 1. Rasterize the strokes at source resolution (masks module, shared with the
 *    brush mask tool) and take their pixel bounding box — this is patch.bbox,
 *    snapped to whole source pixels so `pixels` covers it exactly.
 * 2. Crop bbox + a kind-dependent context margin; every covered pixel
 *    (coverage > 0, i.e. including the feathered rim) is re-synthesized by
 *    PatchMatch in a worker. The core itself limits memory (region downscale)
 *    and time (fine levels only vote, which transfers full-resolution detail
 *    from the upsampled nearest-neighbour field).
 * 3. The patch is RGBA8 sRGB: RGB = filled pixels (original colour where the
 *    coverage is 0, so bilinear sampling at the rim never pulls in garbage),
 *    A = the strokes' feathered coverage.
 *
 * Kinds (all classical, labelled honestly in the UI via INPAINT_KIND_INFO):
 *   'ai-remove'  — 7×7 patches, standard search.
 *   'generative' — larger 11×11 patches, 3× random search, sharper final vote
 *                  (texture synthesis rather than averaging), wider context.
 *   'dust'       — tiny 5×5 patches, small context.
 */
import { rasterizeStrokes, strokesBounds } from '@/editor/masks';
import type { InpaintOptions } from '@/editor/contracts';
import type { BrushStroke, PixelBuffer, PixelBufferU8, RemovalKind, RemovalPatch } from '@/editor/types';
import { runInpaintJob } from './client';
import type { PatchMatchOptions } from './patchmatch';
import { expandRect, maskBounds, readRgba8Region, toPixelRect } from './pixels';

export interface RemovalKindInfo {
  label: string;
  /** Honest description of the algorithm for the UI badge / tooltip. */
  method: string;
  options: Partial<PatchMatchOptions>;
}

export const INPAINT_KIND_INFO: Record<RemovalKind, RemovalKindInfo> = {
  'ai-remove': {
    label: 'Remove',
    method: 'Classical PatchMatch exemplar inpainting (no ML model)',
    options: { patchSize: 7, iterations: 6, searchCandidates: 1, dilate: 2, contextScale: 0.75, sharpness: 1 },
  },
  generative: {
    label: 'Generative Remove',
    method: 'Classical texture synthesis: large-patch PatchMatch with a sharp vote (no generative model)',
    options: { patchSize: 11, iterations: 8, searchCandidates: 3, dilate: 3, contextScale: 1.25, sharpness: 2.5 },
  },
  dust: {
    label: 'Dust Removal',
    method: 'Small-patch PatchMatch inpainting',
    options: { patchSize: 5, iterations: 4, searchCandidates: 1, dilate: 1, contextScale: 1.5, sharpness: 1 },
  },
};

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function createRemovalPatch(
  source: PixelBuffer,
  strokes: BrushStroke[],
  kind: RemovalPatch['kind'],
  opts: InpaintOptions & { idFactory?: () => string } = {},
): Promise<{ patch: RemovalPatch; pixels: PixelBufferU8 }> {
  const W = source.width;
  const H = source.height;
  const id = (opts.idFactory ?? defaultId)();
  const coverage = rasterizeStrokes(strokes, W, H);

  // Tight pixel bbox of the actual coverage (falls back to the strokes' geometric bounds).
  let bbox = maskBounds(coverage, W, H);
  if (!bbox) bbox = toPixelRect(strokesBounds(strokes, W / H), W, H);
  const info = INPAINT_KIND_INFO[kind] ?? INPAINT_KIND_INFO['ai-remove'];
  const options: Partial<PatchMatchOptions> = { ...info.options };
  if (opts.patchSize) options.patchSize = opts.patchSize;
  if (opts.iterations) options.iterations = opts.iterations;

  // Context crop; the core adds its own margin inside this crop, so give it room.
  const extent = Math.max(bbox.w, bbox.h);
  const margin = Math.max(6 * (options.patchSize ?? 7), Math.round((options.contextScale ?? 1) * extent)) + 4;
  const region = expandRect(bbox, margin, W, H);
  const rgba = readRgba8Region(source, region);
  const mask = new Uint8Array(region.w * region.h);
  let any = false;
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      if (coverage[(bbox.y + y) * W + bbox.x + x]) {
        mask[(bbox.y - region.y + y) * region.w + bbox.x - region.x + x] = 255;
        any = true;
      }
    }
  }

  const filled = any
    ? await runInpaintJob(rgba, region.w, region.h, mask, options, { signal: opts.signal, onProgress: opts.onProgress })
    : rgba;

  const out = new Uint8ClampedArray(bbox.w * bbox.h * 4);
  for (let y = 0; y < bbox.h; y++) {
    const ry = bbox.y - region.y + y;
    for (let x = 0; x < bbox.w; x++) {
      const ri = (ry * region.w + bbox.x - region.x + x) * 4;
      const o = (y * bbox.w + x) * 4;
      out[o] = filled[ri];
      out[o + 1] = filled[ri + 1];
      out[o + 2] = filled[ri + 2];
      out[o + 3] = coverage[(bbox.y + y) * W + bbox.x + x];
    }
  }

  const patch: RemovalPatch = {
    id,
    kind,
    bbox: { x: bbox.x / W, y: bbox.y / H, w: bbox.w / W, h: bbox.h / H },
    strokes: strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
    patchKey: id,
  };
  return { patch, pixels: { width: bbox.w, height: bbox.h, data: out, transfer: 'srgb' } };
}
