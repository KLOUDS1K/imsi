/**
 * Minimal TIFF IFD reader. Used where exifr is too heavy or cannot reach the
 * data: RAW orientation for thumbnails (TIFF-based raws incl. ORF/RW2 magic
 * variants), Canon CR3 CMT1..CMT4 blocks and the embedded-preview fallback.
 * Values are decoded to numbers / strings; RATIONALs become floats.
 */
import { u16be, u16le, u32be, u32le } from './binary';

export type TagValue = number[] | string;
export type Ifd = Map<number, TagValue>;

export interface TiffReader {
  le: boolean;
  bytes: Uint8Array;
  /** Offset of the first IFD. */
  ifd0: number;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export function openTiff(bytes: Uint8Array, base = 0): TiffReader | null {
  if (bytes.length < base + 8) return null;
  const bo = String.fromCharCode(bytes[base], bytes[base + 1]);
  if (bo !== 'II' && bo !== 'MM') return null;
  const le = bo === 'II';
  const view = base === 0 ? bytes : bytes.subarray(base);
  const ifd0 = le ? u32le(view, 4) : u32be(view, 4);
  if (ifd0 < 8 || ifd0 >= view.length) return null;
  return { le, bytes: view, ifd0 };
}

/** Read one IFD. Returns the entries and the offset of the next IFD (0 = none). */
export function readIfd(t: TiffReader, offset: number, maxValueBytes = 1 << 16): { tags: Ifd; next: number } {
  const b = t.bytes;
  const r16 = t.le ? u16le : u16be;
  const r32 = t.le ? u32le : u32be;
  const tags: Ifd = new Map();
  if (offset + 2 > b.length) return { tags, next: 0 };
  const n = r16(b, offset);
  if (n > 4096) return { tags, next: 0 };
  for (let i = 0; i < n; i++) {
    const p = offset + 2 + i * 12;
    if (p + 12 > b.length) break;
    const tag = r16(b, p);
    const type = r16(b, p + 2);
    const count = r32(b, p + 4);
    const size = TYPE_SIZE[type] ?? 0;
    if (!size) continue;
    const bytes = size * count;
    if (bytes > maxValueBytes) continue;
    const at = bytes <= 4 ? p + 8 : r32(b, p + 8);
    if (at + bytes > b.length) continue;
    tags.set(tag, readValue(b, at, type, count, t.le));
  }
  const np = offset + 2 + n * 12;
  const next = np + 4 <= b.length ? r32(b, np) : 0;
  return { tags, next: next < b.length ? next : 0 };
}

function readValue(b: Uint8Array, at: number, type: number, count: number, le: boolean): TagValue {
  const r16 = le ? u16le : u16be;
  const r32 = le ? u32le : u32be;
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = b[at + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1:
      case 7:
        out[i] = b[at + i];
        break;
      case 6:
        out[i] = (b[at + i] << 24) >> 24;
        break;
      case 3:
        out[i] = r16(b, at + i * 2);
        break;
      case 8:
        out[i] = (r16(b, at + i * 2) << 16) >> 16;
        break;
      case 4:
      case 13:
        out[i] = r32(b, at + i * 4);
        break;
      case 9:
        out[i] = r32(b, at + i * 4) | 0;
        break;
      case 5: {
        const den = r32(b, at + i * 8 + 4);
        out[i] = den ? r32(b, at + i * 8) / den : 0;
        break;
      }
      case 10: {
        const den = r32(b, at + i * 8 + 4) | 0;
        out[i] = den ? (r32(b, at + i * 8) | 0) / den : 0;
        break;
      }
      case 11:
        out[i] = new DataView(b.buffer, b.byteOffset + at + i * 4, 4).getFloat32(0, le);
        break;
      case 12:
        out[i] = new DataView(b.buffer, b.byteOffset + at + i * 8, 8).getFloat64(0, le);
        break;
      default:
        out[i] = 0;
    }
  }
  return out;
}

export function num(ifd: Ifd | undefined, tag: number): number | undefined {
  const v = ifd?.get(tag);
  return Array.isArray(v) && v.length > 0 && Number.isFinite(v[0]) ? v[0] : undefined;
}

export function str(ifd: Ifd | undefined, tag: number): string | undefined {
  const v = ifd?.get(tag);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function nums(ifd: Ifd | undefined, tag: number): number[] | undefined {
  const v = ifd?.get(tag);
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

/** EXIF orientation from IFD0 of a TIFF-structured file (TIFF, DNG, ARW, NEF, CR2, ORF, RW2, PEF, SRW). */
export function tiffOrientation(bytes: Uint8Array): number | undefined {
  const t = openTiff(bytes);
  if (!t) return undefined;
  const o = num(readIfd(t, t.ifd0, 256).tags, 274);
  return o && o >= 1 && o <= 8 ? o : undefined;
}

/** IFD0, EXIF sub-IFD and GPS sub-IFD of a TIFF block. */
export function readTiffBlocks(bytes: Uint8Array): { ifd0: Ifd; exif?: Ifd; gps?: Ifd } | null {
  const t = openTiff(bytes);
  if (!t) return null;
  const ifd0 = readIfd(t, t.ifd0).tags;
  const exifPtr = num(ifd0, 34665);
  const gpsPtr = num(ifd0, 34853);
  return {
    ifd0,
    exif: exifPtr ? readIfd(t, exifPtr).tags : undefined,
    gps: gpsPtr ? readIfd(t, gpsPtr).tags : undefined,
  };
}
