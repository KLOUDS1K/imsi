/**
 * Stored image size (before EXIF orientation) from the first bytes of a file,
 * without decoding: JPEG SOF, PNG IHDR, WebP (VP8/VP8L/VP8X), GIF, BMP,
 * HEIF/AVIF 'ispe' and TIFF IFD0.
 */
import { ascii, u16le, u32le } from './binary';
import { heifImageSize } from './isobmff';
import { jpegHeaderInfo } from './jpeg';
import { readPngHeader } from './png';
import { num, openTiff, readIfd } from './tiff-ifd';

export interface HeaderInfo {
  width: number;
  height: number;
  /** EXIF orientation found in the header (JPEG APP1 / TIFF IFD0), if any. */
  orientation?: number;
}

export function headerInfo(b: Uint8Array): HeaderInfo | null {
  if (b.length < 16) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return jpegHeaderInfo(b);
  const png = readPngHeader(b);
  if (png) return { width: png.width, height: png.height };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpSize(b);
  if (ascii(b, 0, 3) === 'GIF') return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const w = u32le(b, 18) | 0;
    const h = u32le(b, 22) | 0;
    return { width: Math.abs(w), height: Math.abs(h) };
  }
  if (ascii(b, 4, 4) === 'ftyp') return heifImageSize(b);
  const t = openTiff(b);
  if (t) {
    const ifd = readIfd(t, t.ifd0, 256).tags;
    const w = num(ifd, 256);
    const h = num(ifd, 257);
    if (w && h) return { width: w, height: h, orientation: num(ifd, 274) };
  }
  return null;
}

function webpSize(b: Uint8Array): HeaderInfo | null {
  const fourcc = ascii(b, 12, 4);
  if (fourcc === 'VP8 ' && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && b.length >= 25) {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X' && b.length >= 30) {
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h };
  }
  return null;
}
