/**
 * Canvas helpers that work both in a worker (OffscreenCanvas) and on the main
 * thread (HTMLCanvasElement fallback): bitmap → pixels with a high-quality
 * step-down resize, and pixels → encoded blob.
 */
import type { PixelBufferU8 } from '../types';

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export type CanvasColorSpace = 'srgb' | 'display-p3';

export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

export function createCanvas(w: number, h: number): AnyCanvas {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('No canvas implementation available in this context');
}

export function context2d(c: AnyCanvas, colorSpace: CanvasColorSpace = 'srgb', readback = true): Ctx2D {
  const opts = { alpha: true, colorSpace, willReadFrequently: readback };
  const ctx = (c as OffscreenCanvas).getContext('2d', opts) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/**
 * Draw `src` at (tw × th) and return its RGBA8 pixels. Large reductions are
 * done in successive halvings: with bilinear sampling exactly between source
 * pixels each halving is a 2×2 box average, so the result approximates a
 * true area average (no aliasing) at a fraction of the cost.
 */
export function drawToPixels(
  src: ImageBitmap | AnyCanvas,
  tw: number,
  th: number,
  colorSpace: CanvasColorSpace = 'srgb',
): PixelBufferU8 & { colorSpace: CanvasColorSpace } {
  let cur: ImageBitmap | AnyCanvas = src;
  let cw = src.width;
  let ch = src.height;
  const temps: AnyCanvas[] = [];
  while (cw >= tw * 2 && ch >= th * 2) {
    const nw = Math.max(tw, Math.ceil(cw / 2));
    const nh = Math.max(th, Math.ceil(ch / 2));
    const c = createCanvas(nw, nh);
    const x = context2d(c, colorSpace, false);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur as CanvasImageSource, 0, 0, nw, nh);
    temps.push(c);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = createCanvas(tw, th);
  const ctx = context2d(out, colorSpace, true);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(cur as CanvasImageSource, 0, 0, tw, th);
  const img = colorSpace === 'srgb' ? ctx.getImageData(0, 0, tw, th) : ctx.getImageData(0, 0, tw, th, { colorSpace });
  for (const t of temps) {
    t.width = 0;
    t.height = 0;
  }
  return { width: tw, height: th, data: img.data, transfer: 'srgb', colorSpace };
}

/** Fit (w, h) inside maxSize on the long edge (never enlarges). */
export function fitSize(w: number, h: number, maxSize?: number): { width: number; height: number } {
  if (!maxSize || Math.max(w, h) <= maxSize) return { width: w, height: h };
  const s = maxSize / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export async function canvasToBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), type, quality),
  );
}

/** Encode 8-bit sRGB pixels (PNG / JPEG / WebP, whatever the browser supports). */
export async function encodePixels(px: PixelBufferU8, type = 'image/png', quality?: number): Promise<Blob> {
  const c = createCanvas(px.width, px.height);
  const ctx = context2d(c, 'srgb', false);
  const data = new ImageData(new Uint8ClampedArray(px.data.buffer as ArrayBuffer, px.data.byteOffset, px.data.length), px.width, px.height);
  if (type === 'image/jpeg') {
    // JPEG has no alpha: composite over white like every photo app does.
    const tmp = createCanvas(px.width, px.height);
    context2d(tmp, 'srgb', false).putImageData(data, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px.width, px.height);
    ctx.drawImage(tmp as CanvasImageSource, 0, 0);
  } else {
    ctx.putImageData(data, 0, 0);
  }
  return canvasToBlob(c, type, quality);
}
