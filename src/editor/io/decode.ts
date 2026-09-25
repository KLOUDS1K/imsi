/**
 * decodeFile / makeThumbnail — format dispatch.
 *
 *   JPEG/WebP/AVIF/GIF/BMP/HEIC → createImageBitmap (browser decoder, EXIF orientation applied)
 *   PNG 16-bit                  → own decoder (keeps Uint16)
 *   TIFF                        → UTIF-based decoder (8/16-bit)
 *   RAW                         → LibRaw (WASM, 16-bit linear) with embedded-preview fallback
 */
import LibRaw from 'libraw-wasm';
import type { DecodedPhoto, DecodeOptions } from '../contracts';
import type { PhotoMeta, PixelBuffer, PixelBufferU8, SourceImage } from '../types';
import { newSourceId, throwIfAborted } from './binary';
import { canvasToBlob, createCanvas, context2d, drawToPixels, encodePixels, fitSize } from './canvas';
import { normalizeCameraName } from './camera-names';
import { detectFormat } from './formats';
import { bestPreviewFor, largestEmbeddedJpeg } from './jpeg';
import { metaFromTags, readMetadata } from './metadata';
import { applyOrientation, downscale, rgbToRgba16, toSrgb8 } from './pixels';
import { decodePng, readPngHeader } from './png';
import { flipToOrientation } from './raw-color';
import { decodeTiff } from './tiff';
import { tiffOrientation } from './tiff-ifd';
import { normalizeTransfer } from './trc';

type Loaded = { px: PixelBuffer; bitDepth: 8 | 16 | 32; primaries: SourceImage['primaries']; isRaw: boolean; fullW: number; fullH: number };

async function bitmapFrom(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
}

async function decodeBrowser(blob: Blob, maxSize?: number): Promise<Loaded> {
  const bmp = await bitmapFrom(blob);
  try {
    const { width, height } = fitSize(bmp.width, bmp.height, maxSize);
    const px = drawToPixels(bmp, width, height);
    return { px, bitDepth: 8, primaries: 'srgb', isRaw: false, fullW: bmp.width, fullH: bmp.height };
  } finally {
    bmp.close();
  }
}

/** Largest embedded JPEG of a RAW file (fast path / fallback). */
async function decodeEmbeddedPreview(bytes: Uint8Array, maxSize: number | undefined, orientation: number): Promise<Loaded> {
  const jpg = bestPreviewFor(bytes, maxSize ?? 0);
  if (!jpg) throw new Error('No decodable preview found in this RAW file.');
  const blob = new Blob([bytes.slice(jpg.offset, jpg.end)], { type: 'image/jpeg' });
  const loaded = await decodeBrowser(blob, maxSize);
  // Preview streams rarely carry their own orientation; use the container's.
  if (!jpg.orientation && orientation > 1) {
    loaded.px = applyOrientation(loaded.px, orientation);
    if (orientation >= 5 && orientation <= 8) [loaded.fullW, loaded.fullH] = [loaded.fullH, loaded.fullW];
  }
  const largest = largestEmbeddedJpeg(bytes, { readOrientation: true }) ?? jpg;
  const fullOrientation = largest.orientation ?? orientation;
  loaded.fullW = fullOrientation >= 5 && fullOrientation <= 8 ? largest.height : largest.width;
  loaded.fullH = fullOrientation >= 5 && fullOrientation <= 8 ? largest.width : largest.height;
  // Keep the JPEG's native dimensions. Replacing them with the proxy dimensions
  // makes decodeFile believe it already has the full image and skip loadFull().
  return loaded;
}

async function decodeRaw(bytes: Uint8Array, maxSize: number | undefined, meta: PhotoMeta, opts: DecodeOptions): Promise<Loaded> {
  if (opts.preferEmbeddedPreview) {
    const loaded = await decodeEmbeddedPreview(bytes, maxSize, meta.orientation);
    meta.exif = { ...(meta.exif ?? {}), __kloudFallback: 'embedded-preview' };
    return { ...loaded, isRaw: true };
  }
  const raw = new LibRaw();
  try {
    opts.onProgress?.(0.1, 'Decoding RAW');
    await raw.open(bytes.slice(), {
      outputBps: 16,
      gamm: [1, 1],
      noAutoBright: true,
      useCameraWb: true,
      outputColor: 1,
      userQual: 3,
      halfSize: !!maxSize && maxSize <= 3000,
    });
    const md = await raw.metadata();
    const img = await raw.imageData();
    if (!img || !img.width) throw new Error('LibRaw returned no image');
    opts.onProgress?.(0.8, 'Preparing');
    const rgb = img.data instanceof Uint16Array ? img.data : new Uint16Array(img.data);
    const data = img.colors === 4 ? rgb : rgbToRgba16(rgb, img.width, img.height);
    let px: PixelBuffer = { width: img.width, height: img.height, data, transfer: 'linear' };
    const fullW = md?.width ?? img.width;
    const fullH = md?.height ?? img.height;
    if (md) {
      meta.orientation = flipToOrientation(md.flip);
      if (!meta.make) meta.make = md.camera_make;
      if (!meta.model) meta.model = md.camera_model;
      meta.camera = meta.camera ?? normalizeCameraName(meta.make, meta.model);
      meta.iso = meta.iso ?? (md.iso_speed || undefined);
      meta.shutter = meta.shutter ?? (md.shutter || undefined);
      meta.aperture = meta.aperture ?? (md.aperture || undefined);
      meta.focalLength = meta.focalLength ?? (md.focal_len || undefined);
      if (!meta.dateTaken && md.timestamp instanceof Date && !Number.isNaN(md.timestamp.getTime())) {
        meta.dateTaken = md.timestamp.toISOString();
      }
    }
    px = downscale(px, maxSize ?? 0);
    return { px, bitDepth: 16, primaries: 'srgb', isRaw: true, fullW, fullH };
  } catch (err) {
    throwIfAborted(opts.signal);
    console.warn('[io] LibRaw decode failed, using the embedded preview', err);
    const loaded = await decodeEmbeddedPreview(bytes, maxSize, meta.orientation);
    meta.exif = { ...(meta.exif ?? {}), __kloudFallback: 'embedded-preview' };
    return { ...loaded, isRaw: true };
  } finally {
    try {
      raw.dispose();
    } catch {
      /* already gone */
    }
  }
}

async function load(file: Blob, name: string, meta: PhotoMeta, maxSize: number | undefined, opts: DecodeOptions): Promise<Loaded> {
  throwIfAborted(opts.signal);
  if (meta.format === 'raw') return decodeRaw(new Uint8Array(await file.arrayBuffer()), maxSize, meta, opts);
  if (meta.format === 'tiff') {
    const buf = await file.arrayBuffer();
    const r = decodeTiff(buf, { maxSize });
    const norm = normalizeTransfer(r.px, r.primaries);
    return { px: downscale(norm.px, maxSize ?? 0), bitDepth: r.bitDepth, primaries: norm.primaries, isRaw: false, fullW: r.fullWidth, fullH: r.fullHeight };
  }
  if (meta.format === 'png') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hdr = readPngHeader(bytes);
    if (hdr && hdr.bitDepth === 16) {
      const img = decodePng(bytes);
      let px: PixelBuffer = { width: img.width, height: img.height, data: img.data, transfer: 'srgb' };
      if (img.orientation && img.orientation > 1) px = applyOrientation(px, img.orientation);
      const fullW = px.width;
      const fullH = px.height;
      return { px: downscale(px, maxSize ?? 0), bitDepth: 16, primaries: 'srgb', isRaw: false, fullW, fullH };
    }
  }
  return decodeBrowser(file, maxSize);
}

export async function decodeFile(file: Blob, name: string, opts: DecodeOptions = {}): Promise<DecodedPhoto> {
  opts.onProgress?.(0, 'Reading');
  const meta = await readMetadata(file, name).catch(
    (): PhotoMeta => ({ fileName: name, fileSize: file.size, mimeType: file.type, format: 'unknown', width: 0, height: 0, orientation: 1, bitDepth: 8 }),
  );
  const id = newSourceId();
  const toSource = (l: Loaded): SourceImage => ({
    ...l.px,
    id,
    meta,
    isRaw: l.isRaw,
    bitDepth: l.bitDepth,
    primaries: l.primaries,
    fullWidth: l.fullW,
    fullHeight: l.fullH,
  });
  const first = await load(file, name, meta, opts.maxSize, opts);
  meta.width = first.fullW;
  meta.height = first.fullH;
  if (first.bitDepth === 16) meta.bitDepth = Math.max(meta.bitDepth, 16);
  const source = toSource(first);
  opts.onProgress?.(1, 'Done');
  const isProxy = first.px.width < first.fullW || first.px.height < first.fullH;
  return {
    source,
    meta,
    loadFull: async () => (isProxy ? toSource(await load(file, name, meta, undefined, { ...opts, onProgress: undefined })) : source),
  };
}

/** Fast JPEG thumbnail (≤ maxSize), RAW via the embedded preview. */
export async function makeThumbnail(file: Blob, name: string, maxSize = 320): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const fmt = detectFormat(head, name, file.type);
  let px: PixelBufferU8;
  if (fmt.format === 'raw') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const preview: PixelBuffer = await decodeEmbeddedPreview(bytes, maxSize, tiffOrientation(bytes) || 1)
      .then((l) => l.px)
      .catch(async () => (await decodeFile(file, name, { maxSize })).source);
    px = toSrgb8(downscale(preview, maxSize));
  } else if (fmt.format === 'tiff' || fmt.format === 'png') {
    const d = await decodeFile(file, name, { maxSize });
    px = toSrgb8(d.source);
  } else {
    const bmp = await bitmapFrom(file);
    try {
      const { width, height } = fitSize(bmp.width, bmp.height, maxSize);
      const c = createCanvas(width, height);
      const g = context2d(c, 'srgb', false) as CanvasRenderingContext2D;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, width, height);
      return await canvasToBlob(c, 'image/jpeg', 0.82);
    } finally {
      bmp.close();
    }
  }
  return encodePixels(px, 'image/jpeg', 0.82);
}

export async function blobToPixelBuffer(blob: Blob, maxSize?: number): Promise<PixelBufferU8> {
  const l = await decodeBrowser(blob, maxSize);
  return toSrgb8(l.px);
}

export async function pixelBufferToBlob(px: PixelBuffer, type = 'image/png', quality?: number): Promise<Blob> {
  return encodePixels(toSrgb8(px), type, quality);
}

export { metaFromTags };
