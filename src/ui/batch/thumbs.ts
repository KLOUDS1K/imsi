/**
 * Thumbnail regeneration after batch edits.
 *
 * Photos whose edit changed while they were not open get a fresh library
 * thumbnail rendered by the engine: decode at ≤ 512 px, renderFull at the
 * cropped output aspect (long edge ≤ 320), JPEG-encode, library.setThumbnail.
 * The open document uses engine.renderThumbnail (its proxy is already on the
 * GPU).
 *
 * One job runs at a time with a short idle gap between jobs so the UI stays
 * responsive; ids queued twice are rendered once. Without an engine (WebGL2
 * missing or not ready yet) the queue is dropped silently — the stored
 * thumbnail simply keeps showing the unedited photo.
 */
import type { AppContext } from '@/app/context';
import type { EditParams, RenderedImage } from '@/editor/types';
import { createDefaultParams } from '@/editor/defaults';
import { normalizeParams } from '@/editor/state';

const THUMB_EDGE = 320;
const DECODE_EDGE = 512;
const GAP_MS = 40;

interface ThumbQueue {
  pending: Set<string>;
  running: boolean;
}
const queues = new WeakMap<AppContext, ThumbQueue>();

/** Encode an 8-bit RenderedImage (or a 16-bit one, reduced) as an image blob. */
export async function renderedToBlob(img: RenderedImage, type = 'image/jpeg', quality = 0.86): Promise<Blob> {
  const n = img.width * img.height * 4;
  let rgba: Uint8ClampedArray<ArrayBuffer>;
  if (img.data instanceof Uint8ClampedArray && img.data.buffer instanceof ArrayBuffer) {
    rgba = img.data as Uint8ClampedArray<ArrayBuffer>;
  } else {
    rgba = new Uint8ClampedArray(n);
    const src = img.data;
    const shift = img.bitDepth === 16 ? 257 : 1;
    for (let i = 0; i < n; i++) rgba[i] = src[i] / shift;
  }
  const data = new ImageData(rgba, img.width, img.height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    g.putImageData(data, 0, 0);
    return c.convertToBlob({ type, quality });
  }
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.putImageData(data, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality));
}

/** Fit (w, h) so the long edge is ≤ max (never 0). */
export function fitLongEdge(w: number, h: number, max: number): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

async function renderOne(ctx: AppContext, id: string): Promise<void> {
  const engine = ctx.engine;
  const rec = ctx.library.get(id);
  if (!engine || !rec) return;
  const doc = ctx.doc.value;
  if (doc && doc.photoId === id) {
    const blob = await engine.renderThumbnail(doc.store.params, THUMB_EDGE);
    await ctx.library.setThumbnail(id, blob);
    return;
  }
  const file = await ctx.library.getFile(id);
  if (!file) return;
  const [{ decodeFile }, geometry] = await Promise.all([import('@/editor/io'), import('@/editor/engine/geometry')]);
  const decoded = await decodeFile(file, rec.name, { maxSize: DECODE_EDGE });
  const isRaw = rec.meta?.format === 'raw';
  const saved = await ctx.library.loadEdit(id);
  const params: EditParams = saved ? normalizeParams(saved.params, isRaw) : createDefaultParams(isRaw);
  const out = geometry.outputSize(params, decoded.source.width, decoded.source.height);
  const size = fitLongEdge(out.width, out.height, THUMB_EDGE);
  const img = await engine.renderFull(params, { ...size, bitDepth: 8, colorSpace: 'srgb', source: decoded.source });
  await ctx.library.setThumbnail(id, await renderedToBlob(img));
}

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, GAP_MS);
  });

async function drain(ctx: AppContext, q: ThumbQueue): Promise<void> {
  q.running = true;
  try {
    while (q.pending.size > 0) {
      if (!ctx.engine) {
        q.pending.clear();
        break;
      }
      const id = q.pending.values().next().value as string;
      q.pending.delete(id);
      try {
        await renderOne(ctx, id);
      } catch (err) {
        // A failed thumbnail is cosmetic: keep going with the rest.
        console.warn('[batch] thumbnail refresh failed for', id, err);
      }
      await idle();
    }
  } finally {
    q.running = false;
  }
}

/** Queue thumbnail re-renders for photos whose edit changed. No-op without an engine. */
export function queueThumbnailRefresh(ctx: AppContext, ids: readonly string[]): void {
  if (!ctx.engine || ids.length === 0) return;
  let q = queues.get(ctx);
  if (!q) {
    q = { pending: new Set(), running: false };
    queues.set(ctx, q);
  }
  for (const id of ids) q.pending.add(id);
  if (!q.running) void drain(ctx, q);
}
