/**
 * Watermark module: text / logo / KLOUD house-style marks, drawn as vector text
 * (or a scaled logo) at the target resolution.
 */
import type { WatermarkModule } from '@/editor/contracts';
import type { RenderedImage, WatermarkSettings } from '@/editor/types';
import { ensureFont, fontStack } from './fonts';
import { layoutImage, layoutText, type Ctx2D, type WatermarkLayout } from './layout';

export { fontStack, ensureFont } from './fonts';
export type { WatermarkLayout, Box } from './layout';

/* ---------------- logo cache ---------------- */

interface Logo {
  src: CanvasImageSource;
  width: number;
  height: number;
}

const logoCache = new Map<string, Promise<Logo | null>>();

async function decodeLogo(url: string): Promise<Logo | null> {
  // <img> handles SVG logos (vector, crisp at any size); workers fall back to ImageBitmap.
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      return null;
    }
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    return { src: img, width: w, height: h };
  }
  if (typeof createImageBitmap === 'undefined') return null;
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    return { src: bmp, width: bmp.width, height: bmp.height };
  } catch {
    return null;
  }
}

function loadLogo(url: string): Promise<Logo | null> {
  let p = logoCache.get(url);
  if (!p) {
    if (logoCache.size >= 4) logoCache.delete(logoCache.keys().next().value as string);
    p = decodeLogo(url);
    logoCache.set(url, p);
  }
  return p;
}

/* ---------------- canvas helpers ---------------- */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') throw new Error('no canvas available for the watermark');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context2d(c: AnyCanvas, readback = false): Ctx2D {
  const ctx = c.getContext('2d', readback ? { willReadFrequently: true } : undefined) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

const textSample = (wm: WatermarkSettings) =>
  wm.kind === 'text' ? wm.text || 'A' : wm.kind === 'kloud' ? 'KLOUD' : 'KLOUD.PHOTOGRAPHY';

/** Resolve fonts / logo and compute where the mark goes on a w×h target. */
async function layout(ctx: Ctx2D, w: number, h: number, wm: WatermarkSettings): Promise<WatermarkLayout | null> {
  if (!(w > 0 && h > 0)) return null;
  if (wm.kind === 'image') {
    if (!wm.imageDataUrl) return null;
    const logo = await loadLogo(wm.imageDataUrl);
    return logo ? layoutImage(w, h, wm, logo.src, logo.width, logo.height) : null;
  }
  const stack = fontStack(wm.fontFamily || 'Inter');
  const weight = wm.kind === 'text' ? wm.fontWeight : Math.max(wm.fontWeight, 700);
  await ensureFont(stack, weight, textSample(wm));
  if (wm.kind === 'kloud-photography') await ensureFont(stack, 500, '.PHOTOGRAPHY');
  return layoutText(ctx, w, h, wm);
}

/* ---------------- public API ---------------- */

/** Draw the mark onto a 2D context of a w×h image (regardless of `wm.enabled`). */
export async function drawWatermark(ctx: Ctx2D, w: number, h: number, wm: WatermarkSettings): Promise<void> {
  const l = await layout(ctx, w, h, wm);
  l?.draw(ctx);
}

/**
 * Composite the mark onto a RenderedImage in place. Only the mark's bounding
 * box (+ shadow bleed) is rasterized, into a transparent 8-bit RGBA layer,
 * which is then alpha-blended into the image data ("over", in the image's
 * encoded space — the same maths the canvas uses). 16-bit images get the
 * layer colour scaled by 257.
 */
export async function applyWatermark(img: RenderedImage, wm: WatermarkSettings): Promise<void> {
  if (!wm.enabled) return;
  const { width: W, height: H, data } = img;
  const measure = context2d(createCanvas(1, 1));
  const l = await layout(measure, W, H, wm);
  if (!l) return;
  const x0 = Math.max(0, Math.floor(l.box.x - l.bleed));
  const y0 = Math.max(0, Math.floor(l.box.y - l.bleed));
  const x1 = Math.min(W, Math.ceil(l.box.x + l.box.width + l.bleed));
  const y1 = Math.min(H, Math.ceil(l.box.y + l.box.height + l.bleed));
  const lw = x1 - x0;
  const lh = y1 - y0;
  if (lw <= 0 || lh <= 0) return;

  const layer = createCanvas(lw, lh);
  const ctx = context2d(layer, true);
  ctx.translate(-x0, -y0);
  l.draw(ctx);
  const px = ctx.getImageData(0, 0, lw, lh).data;

  const sixteen = img.bitDepth === 16;
  const scale = sixteen ? 257 : 1;
  const bias = sixteen ? 0.5 : 0; // Uint16Array truncates; Uint8ClampedArray rounds
  for (let y = 0; y < lh; y++) {
    let s = y * lw * 4;
    let d = ((y0 + y) * W + x0) * 4;
    for (let x = 0; x < lw; x++, s += 4, d += 4) {
      const a = px[s + 3];
      if (a === 0) continue;
      const A = a / 255;
      const k = 1 - A;
      data[d] = data[d] * k + px[s] * scale * A + bias;
      data[d + 1] = data[d + 1] * k + px[s + 1] * scale * A + bias;
      data[d + 2] = data[d + 2] * k + px[s + 2] * scale * A + bias;
      // Alpha: "over" onto (usually opaque) image.
      const da = data[d + 3];
      data[d + 3] = da + (scale * 255 - da) * A + bias;
    }
  }
  if ('width' in layer) {
    layer.width = 0;
    layer.height = 0;
  }
}

function sourceSize(s: CanvasImageSource): { w: number; h: number } {
  const o = s as Partial<{
    naturalWidth: number;
    naturalHeight: number;
    videoWidth: number;
    videoHeight: number;
    displayWidth: number;
    displayHeight: number;
    width: number | SVGAnimatedLength;
    height: number | SVGAnimatedLength;
  }>;
  if (o.naturalWidth) return { w: o.naturalWidth, h: o.naturalHeight ?? 0 };
  if (o.videoWidth) return { w: o.videoWidth, h: o.videoHeight ?? 0 };
  if (o.displayWidth) return { w: o.displayWidth, h: o.displayHeight ?? 0 };
  const w = typeof o.width === 'number' ? o.width : (o.width?.baseVal.value ?? 0);
  const h = typeof o.height === 'number' ? o.height : (o.height?.baseVal.value ?? 0);
  return { w, h };
}

const previewGen = new WeakMap<HTMLCanvasElement, number>();

function tokenColor(el: Element, name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Preview for the export dialog: the background (or a neutral grey 3:2 sample)
 * letterboxed into the canvas, with the mark laid out relative to the image
 * area exactly as it will be on export. Uses the canvas' pixel size as is; if
 * it has none yet, it is sized from its CSS box × devicePixelRatio.
 */
export async function renderWatermarkPreview(canvas: HTMLCanvasElement, wm: WatermarkSettings, background?: CanvasImageSource | null): Promise<void> {
  if (!canvas.width || !canvas.height) {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 320) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 213) * dpr));
  }
  const W = canvas.width;
  const H = canvas.height;
  const ctx = context2d(canvas);
  const gen = (previewGen.get(canvas) ?? 0) + 1;
  previewGen.set(canvas, gen);

  const bg = background ? sourceSize(background) : null;
  const aspect = bg && bg.w > 0 && bg.h > 0 ? bg.w / bg.h : 3 / 2;
  const pad = Math.round(Math.min(W, H) * 0.04);
  const iw = Math.max(1, Math.round(Math.min(W - 2 * pad, (H - 2 * pad) * aspect)));
  const ih = Math.max(1, Math.round(iw / aspect));
  const ix = Math.round((W - iw) / 2);
  const iy = Math.round((H - ih) / 2);

  // Resolve fonts/logo first, then paint synchronously: a slower earlier call can
  // never paint over a newer one (slider drags fire many previews).
  const mark = wm.enabled ? await layout(ctx, iw, ih, wm) : null;
  if (previewGen.get(canvas) !== gen) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = tokenColor(canvas, '--k-canvas', '#1f1f21');
  ctx.fillRect(0, 0, W, H);
  if (background && bg && bg.w > 0) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(background, ix, iy, iw, ih);
  } else {
    // Neutral mid-grey sample with a gentle falloff, so light and dark marks both read.
    const g = ctx.createLinearGradient(0, iy, 0, iy + ih);
    g.addColorStop(0, '#8c8c8c');
    g.addColorStop(1, '#5c5c5c');
    ctx.fillStyle = g;
    ctx.fillRect(ix, iy, iw, ih);
  }
  if (mark) {
    ctx.beginPath();
    ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.translate(ix, iy);
    mark.draw(ctx);
  }
  ctx.restore();
}

export const watermarkModule = { drawWatermark, applyWatermark, renderWatermarkPreview } satisfies WatermarkModule;
