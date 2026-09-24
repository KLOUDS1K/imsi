/**
 * encodeImage: RenderedImage → file bytes for every export format, with ICC
 * profile, EXIF/XMP per metadata policy and DPI.
 *
 *  - JPEG / WebP: the browser's encoder (OffscreenCanvas.convertToBlob, or a
 *    <canvas> fallback), then the byte stream is rewritten to carry our
 *    metadata (JFIF density, Exif, XMP, chunked ICC / VP8X + ICCP/EXIF/XMP).
 *    16-bit input is dithered down to 8-bit first. Raw code values are passed
 *    through untouched (sRGB canvas + sRGB ImageData = no conversion), so
 *    Display P3 / Adobe RGB data is labelled by the embedded profile.
 *  - PNG / TIFF / DNG: our own encoders, run in a worker.
 */
import { buildIccProfile, ICC_SHORT_NAME } from './icc';
import { injectJpegMetadata } from './jpeg';
import { buildExifTiff, buildMetadata } from './metadata';
import { to16bit, to8bit } from './pixels';
import { injectWebpMetadata } from './webp';
import { runEncodeTask } from './worker-client';
import type { ExportSettings, PhotoMeta, RenderedImage } from '@/editor/types';

export const MIME: Record<ExportSettings['format'], string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  dng: 'image/x-adobe-dng',
};

export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
}

/** Encode RGBA8 with the browser's image encoder. */
export async function encodeWithCanvas(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  type: 'image/jpeg' | 'image/webp' | 'image/png',
  quality: number,
): Promise<Blob> {
  const imageData = new ImageData(rgba, width, height);
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(imageData, 0, 0);
    blob = await c.convertToBlob({ type, quality });
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(imageData, 0, 0);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, quality));
    c.width = c.height = 0;
  } else {
    throw new Error('no canvas available to encode images');
  }
  if (!blob) throw new Error(`the browser could not encode a ${width}×${height} ${type} (image too large?)`);
  // Browsers without an encoder for `type` silently return PNG.
  if (blob.type !== type) throw new Error(`${type} encoding is not supported by this browser`);
  return blob;
}

function checkImage(img: RenderedImage): void {
  if (!(img.width > 0 && img.height > 0)) throw new Error('image has no pixels');
  if (img.data.length !== img.width * img.height * 4) throw new Error('image data length does not match width × height × 4');
}

export async function encodeImage(img: RenderedImage, settings: ExportSettings, meta: PhotoMeta): Promise<Blob> {
  checkImage(img);
  const { width, height } = img;
  const blocks = buildMetadata(settings, meta, img);
  const format = settings.format;

  if (format === 'jpeg' || format === 'webp') {
    const rgba8 =
      img.bitDepth === 16 || img.data instanceof Uint16Array
        ? to8bit(img.data as Uint16Array)
        : (img.data as Uint8ClampedArray<ArrayBuffer>);
    const type = MIME[format] as 'image/jpeg' | 'image/webp';
    const q = Math.min(1, Math.max(0.01, (Number.isFinite(settings.quality) ? settings.quality : 90) / 100));
    const raw = new Uint8Array(await (await encodeWithCanvas(rgba8, width, height, type, q)).arrayBuffer());
    const payload = { exif: buildExifTiff(blocks), xmp: blocks.xmp, icc: buildIccProfile(img.colorSpace), dpi: settings.dpi };
    const out = format === 'jpeg' ? injectJpegMetadata(raw, payload) : injectWebpMetadata(raw, width, height, payload);
    return bytesToBlob(out, type);
  }

  // PNG / TIFF honour settings.bitDepth; DNG is always 16-bit (converted in the LUT).
  const depth: 8 | 16 = format === 'dng' ? img.bitDepth : settings.bitDepth === 16 ? 16 : 8;
  let data: Uint8ClampedArray | Uint16Array = img.data;
  if (depth === 16 && !(data instanceof Uint16Array)) data = to16bit(data);
  else if (depth === 8 && data instanceof Uint16Array) data = to8bit(data);

  let bytes: Uint8Array;
  if (format === 'png') {
    bytes = await runEncodeTask({
      kind: 'png',
      data,
      width,
      height,
      bitDepth: depth,
      meta: {
        icc: { name: ICC_SHORT_NAME[img.colorSpace], data: buildIccProfile(img.colorSpace) },
        dpi: settings.dpi,
        exif: buildExifTiff(blocks),
        xmp: blocks.xmp,
      },
    });
  } else if (format === 'tiff') {
    bytes = await runEncodeTask({
      kind: 'tiff',
      data,
      width,
      height,
      bitDepth: depth,
      opts: { compression: 'deflate', predictor: true, metadata: blocks, icc: buildIccProfile(img.colorSpace) },
    });
  } else if (format === 'dng') {
    bytes = await runEncodeTask({
      kind: 'dng',
      data,
      width,
      height,
      bitDepth: depth,
      opts: { colorSpace: img.colorSpace, metadata: blocks },
    });
  } else {
    throw new Error(`unsupported export format: ${String(format)}`);
  }
  return bytesToBlob(bytes, MIME[format]);
}
