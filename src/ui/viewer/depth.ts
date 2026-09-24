/**
 * Depth map lookup for the depth-range mask sampler.
 *
 * Convention (see docs/CONTRACT_CHANGES.md, [ui-viewer]): the depth map of a
 * photo lives in ctx.aiMaskStore under `depth:<photoId>` (0 = near … 255 = far,
 * source space). When it is missing we tell the user and estimate it with the
 * segmentation module (classical depth cues unless an ML backend is loaded),
 * then store it under that key so the mask provider and later clicks reuse it.
 */
import type { AppContext, EditorDocument } from '@/app/context';
import type { MaskBitmap } from '@/editor/types';

export const depthKey = (photoId: string): string => `depth:${photoId}`;

const inflight = new Map<string, Promise<MaskBitmap | null>>();

export async function lookupDepth(ctx: AppContext, doc: EditorDocument): Promise<MaskBitmap | null> {
  const key = depthKey(doc.photoId);
  const have = ctx.aiMaskStore.get(key);
  if (have) return have;
  let job = inflight.get(key);
  if (!job) {
    ctx.toast('No depth map yet — estimating depth for this photo…', 'info', 2600);
    job = (async () => {
      ctx.busy.set({ active: true, label: 'Estimating depth…' });
      try {
        const seg = await import('@/editor/ai/segment');
        const bmp = await seg.estimateDepth(doc.analysisProxy);
        ctx.aiMaskStore.set(key, bmp);
        return bmp;
      } catch (err) {
        console.error(err);
        ctx.toast('Depth estimation is unavailable — generate a depth map from the Masks panel first.', 'error');
        return null;
      } finally {
        ctx.busy.set({ active: false });
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
  }
  return job;
}

/** Bilinear depth 0..1 at source-normalized (x, y). */
export function sampleDepth(bmp: MaskBitmap, x: number, y: number): number {
  const fx = Math.min(bmp.width - 1, Math.max(0, x * bmp.width - 0.5));
  const fy = Math.min(bmp.height - 1, Math.max(0, y * bmp.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(bmp.width - 1, x0 + 1);
  const y1 = Math.min(bmp.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = bmp.data;
  const w = bmp.width;
  const top = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
  const bot = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
  return (top * (1 - ty) + bot * ty) / 255;
}
