/**
 * ISOBMFF helpers: Canon CR3 metadata blocks (CMT1..CMT4 are plain TIFF
 * structures inside moov/uuid) — exifr cannot read CR3 — and the image size
 * of HEIC/AVIF files ('ispe' property).
 */
import { ascii, indexOfBytes, u32be } from './binary';

/** Canon's metadata container uuid (moov/uuid). */
const CANON_UUID = [0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48];

interface Box {
  type: string;
  start: number;
  /** payload start (after header / uuid) */
  data: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      // 64-bit size; files beyond 4 GB are not realistic here, use the low word.
      size = u32be(b, p + 12) + u32be(b, p + 8) * 4294967296;
      hdr = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < hdr) return;
    // A box may run past `to` when we only hold the file head: clamp it.
    const end = Math.min(p + size, to);
    let data = p + hdr;
    if (type === 'uuid') data += 16;
    yield { type, start: p, data, end };
    p += size;
  }
}

export interface Cr3Blocks {
  cmt1?: Uint8Array;
  cmt2?: Uint8Array;
  cmt3?: Uint8Array;
  cmt4?: Uint8Array;
}

/** Locate the CMT1 (IFD0), CMT2 (EXIF), CMT3 (MakerNote) and CMT4 (GPS) TIFF blocks of a CR3 file. */
export function findCr3Blocks(b: Uint8Array): Cr3Blocks {
  const out: Cr3Blocks = {};
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== 'moov') continue;
    for (const child of boxes(b, top.data, top.end)) {
      if (child.type !== 'uuid') continue;
      let same = true;
      for (let i = 0; i < 16; i++) if (b[child.start + 8 + i] !== CANON_UUID[i]) same = false;
      if (!same) continue;
      for (const c of boxes(b, child.data, child.end)) {
        const payload = b.subarray(c.data, c.end);
        if (c.type === 'CMT1') out.cmt1 = payload;
        else if (c.type === 'CMT2') out.cmt2 = payload;
        else if (c.type === 'CMT3') out.cmt3 = payload;
        else if (c.type === 'CMT4') out.cmt4 = payload;
      }
    }
  }
  return out;
}

/** Largest 'ispe' (image spatial extents) in a HEIC/AVIF head, i.e. the primary image size. */
export function heifImageSize(b: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const tag = [0x69, 0x73, 0x70, 0x65]; // 'ispe'
  let p = 0;
  for (;;) {
    const i = indexOfBytes(b, tag, p);
    if (i < 4 || i + 16 > b.length) break;
    // box: size(4) 'ispe' version/flags(4) width(4) height(4)
    const width = u32be(b, i + 8);
    const height = u32be(b, i + 12);
    if (width > 0 && height > 0 && width < 1e6 && height < 1e6 && (!best || width * height > best.width * best.height)) {
      best = { width, height };
    }
    p = i + 4;
  }
  return best;
}
