/**
 * TIFF decoding through UTIF (strips/tiles; none, LZW, Deflate, PackBits,
 * JPEG, CCITT). 8/16-bit gray, gray+alpha, RGB and RGBA are unpacked here at
 * full precision (Uint16 for 16-bit, Float32 for 32-bit float samples);
 * everything else (palette, CMYK, YCbCr, 1–4 bit) goes through
 * UTIF.toRGBA8. EXIF orientation is applied, the ICC profile decides the
 * primaries.
 */
import UTIF, { type UtifIfd } from 'utif';
import type { ColorPrimaries, PixelBuffer } from '../types';
import { parseIcc } from './icc';
import { applyOrientation, downscale, orientedSize } from './pixels';
import { normalizeTransfer } from './trc';

export interface TiffDecodeResult {
  px: PixelBuffer;
  bitDepth: 8 | 16 | 32;
  fileBitDepth: number;
  primaries: ColorPrimaries;
  orientation: number;
  /** Size of the main image after orientation. */
  fullWidth: number;
  fullHeight: number;
}

const tag = (ifd: UtifIfd, t: number): number | undefined => {
  const v = ifd[`t${t}`];
  return Array.isArray(v) && typeof v[0] === 'number' ? (v[0] as number) : undefined;
};
const tags = (ifd: UtifIfd, t: number): number[] | undefined => {
  const v = ifd[`t${t}`];
  return Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]) : undefined;
};

function imageIfds(ifds: UtifIfd[]): UtifIfd[] {
  const all: UtifIfd[] = [];
  const visit = (list: UtifIfd[] | undefined): void => {
    for (const d of list ?? []) {
      if (tag(d, 256) && tag(d, 257) && tag(d, 262) !== 32803 && tag(d, 262) !== 34892) all.push(d);
      visit(d.subIFD);
    }
  };
  visit(ifds);
  return all;
}

/**
 * Decode a TIFF. `minLong` (thumbnails) picks the smallest embedded
 * resolution whose long edge is ≥ minLong instead of the main image.
 */
export function decodeTiff(buffer: ArrayBuffer, opts: { maxSize?: number; minLong?: number } = {}): TiffDecodeResult {
  const ifds = UTIF.decode(buffer);
  const candidates = imageIfds(ifds);
  if (!candidates.length) throw new Error('TIFF contains no decodable image');
  const area = (d: UtifIfd): number => (tag(d, 256) ?? 0) * (tag(d, 257) ?? 0);
  const main = candidates.reduce((a, b) => (area(b) > area(a) ? b : a));
  let pick = main;
  if (opts.minLong) {
    const fit = candidates
      .filter((d) => Math.max(tag(d, 256) ?? 0, tag(d, 257) ?? 0) >= opts.minLong!)
      .sort((a, b) => area(a) - area(b))[0];
    if (fit) pick = fit;
  }
  UTIF.decodeImage(buffer, pick, ifds);
  const orientation = tag(ifds[0], 274) ?? tag(pick, 274) ?? 1;
  const iccTag = pick['t34675'] ?? ifds[0]['t34675'];
  let primaries: ColorPrimaries = 'srgb';
  if (Array.isArray(iccTag) && iccTag.length > 128) {
    const info = parseIcc(Uint8Array.from(iccTag as number[]));
    if (info && info.primaries !== 'other') primaries = info.primaries;
  }
  const unpacked = unpack(pick);
  let px = unpacked.px;
  const norm = normalizeTransfer(px, primaries);
  px = norm.px;
  px = applyOrientation(px, orientation);
  if (opts.maxSize) px = downscale(px, opts.maxSize);
  const full = orientedSize(tag(main, 256) ?? px.width, tag(main, 257) ?? px.height, orientation);
  const bitDepth: 8 | 16 | 32 = px.data instanceof Float32Array ? 32 : px.data instanceof Uint16Array ? 16 : 8;
  return {
    px,
    bitDepth,
    fileBitDepth: unpacked.fileBits,
    primaries: norm.primaries,
    orientation,
    fullWidth: full.width,
    fullHeight: full.height,
  };
}

function unpack(ifd: UtifIfd): { px: PixelBuffer; fileBits: number } {
  const w = ifd.width ?? tag(ifd, 256) ?? 0;
  const h = ifd.height ?? tag(ifd, 257) ?? 0;
  const bps = tags(ifd, 258) ?? [1];
  const bits = bps[0];
  const spp = tag(ifd, 277) ?? bps.length;
  const photometric = tag(ifd, 262) ?? (spp >= 3 ? 2 : 1);
  const planar = tag(ifd, 284) ?? 1;
  const format = tag(ifd, 339) ?? 1;
  const compression = tag(ifd, 259) ?? 1;
  const extra = tags(ifd, 338);
  const data = ifd.data;
  const simple =
    data &&
    planar === 1 &&
    (photometric === 1 || photometric === 0 || photometric === 2) &&
    compression !== 6 &&
    compression !== 7 &&
    ((bits === 8 && format === 1) || (bits === 16 && format === 1) || (bits === 32 && format === 3)) &&
    spp >= 1 &&
    spp <= 8;
  if (!simple) {
    const rgba = UTIF.toRGBA8(ifd);
    return { px: { width: w, height: h, data: new Uint8Array(rgba.buffer, rgba.byteOffset, w * h * 4), transfer: 'srgb' }, fileBits: bits };
  }
  const colorCh = photometric === 2 ? 3 : 1;
  // Alpha = first extra sample; associated (1) alpha is premultiplied.
  const hasAlpha = spp > colorCh;
  const assoc = hasAlpha && extra?.[0] === 1;
  const invert = photometric === 0;
  const n = w * h;
  const bytesPerSample = bits >> 3;
  const rowBytes = w * spp * bytesPerSample;
  if (bits === 8) {
    const out = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) {
      let s = y * rowBytes;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, s += spp, o += 4) {
        let r = data[s];
        let g = colorCh === 3 ? data[s + 1] : r;
        let b = colorCh === 3 ? data[s + 2] : r;
        const a = hasAlpha ? data[s + colorCh] : 255;
        if (invert) {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        }
        if (assoc && a > 0 && a < 255) {
          const k = 255 / a;
          r = Math.min(255, Math.round(r * k));
          g = Math.min(255, Math.round(g * k));
          b = Math.min(255, Math.round(b * k));
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
    return { px: { width: w, height: h, data: out, transfer: 'srgb' }, fileBits: 8 };
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (bits === 16) {
    // UTIF converts 16-bit samples to little-endian while decoding (non-DNG files).
    const out = new Uint16Array(n * 4);
    for (let y = 0; y < h; y++) {
      let s = y * rowBytes;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, s += spp * 2, o += 4) {
        let r = dv.getUint16(s, true);
        let g = colorCh === 3 ? dv.getUint16(s + 2, true) : r;
        let b = colorCh === 3 ? dv.getUint16(s + 4, true) : r;
        const a = hasAlpha ? dv.getUint16(s + colorCh * 2, true) : 65535;
        if (invert) {
          r = 65535 - r;
          g = 65535 - g;
          b = 65535 - b;
        }
        if (assoc && a > 0 && a < 65535) {
          const k = 65535 / a;
          r = Math.min(65535, Math.round(r * k));
          g = Math.min(65535, Math.round(g * k));
          b = Math.min(65535, Math.round(b * k));
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
    return { px: { width: w, height: h, data: out, transfer: 'srgb' }, fileBits: 16 };
  }
  // 32-bit IEEE float: scene-referred, treated as linear light.
  const le = ifd.isLE !== false;
  const out = new Float32Array(n * 4);
  for (let y = 0; y < h; y++) {
    let s = y * rowBytes;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, s += spp * 4, o += 4) {
      const r = dv.getFloat32(s, le);
      out[o] = r;
      out[o + 1] = colorCh === 3 ? dv.getFloat32(s + 4, le) : r;
      out[o + 2] = colorCh === 3 ? dv.getFloat32(s + 8, le) : r;
      out[o + 3] = hasAlpha ? dv.getFloat32(s + colorCh * 4, le) : 1;
    }
  }
  return { px: { width: w, height: h, data: out, transfer: 'linear' }, fileBits: 32 };
}
