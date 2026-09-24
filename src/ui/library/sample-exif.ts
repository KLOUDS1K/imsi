/**
 * Minimal EXIF (APP1) writer for the generated sample photos, so the demo
 * library has camera, lens, ISO, aperture, shutter, focal length and capture
 * date to browse, filter and sort by. Little-endian TIFF with IFD0 + Exif IFD.
 */

export interface SampleExif {
  make: string;
  model: string;
  lens: string;
  /** seconds */
  exposure: number;
  fNumber: number;
  iso: number;
  focal: number;
  focal35?: number;
  /** "YYYY:MM:DD HH:MM:SS" */
  date: string;
  software?: string;
  artist?: string;
}

type Value = { type: 2; text: string } | { type: 3; value: number } | { type: 4; value: number } | { type: 5; num: number; den: number };
interface Tag {
  tag: number;
  v: Value;
}

const enc = new TextEncoder();

/** Rational approximation good enough for EXIF (1/250 s, f/1.8, 35 mm). */
function rational(x: number): { num: number; den: number } {
  if (x >= 1 || x === 0) {
    const den = 10;
    return { num: Math.round(x * den), den };
  }
  const inv = Math.round(1 / x);
  if (Math.abs(1 / inv - x) / x < 0.02) return { num: 1, den: inv };
  return { num: Math.round(x * 10000), den: 10000 };
}

function sizeOf(v: Value): number {
  switch (v.type) {
    case 2:
      return enc.encode(v.text).length + 1;
    case 3:
      return 2;
    case 4:
      return 4;
    case 5:
      return 8;
  }
}

/** Serialize one IFD at `offset` (TIFF-relative); returns its bytes. `nextIfd` = 0 ends the chain. */
function writeIfd(tags: Tag[], offset: number): Uint8Array {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const head = 2 + sorted.length * 12 + 4;
  const extra = sorted.reduce((n, t) => {
    const s = sizeOf(t.v);
    return n + (s > 4 ? s + (s & 1) : 0);
  }, 0);
  const buf = new Uint8Array(head + extra);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, sorted.length, true);
  let data = head;
  sorted.forEach((t, i) => {
    const p = 2 + i * 12;
    const size = sizeOf(t.v);
    dv.setUint16(p, t.tag, true);
    dv.setUint16(p + 2, t.v.type, true);
    dv.setUint32(p + 4, t.v.type === 2 ? size : 1, true);
    const at = size > 4 ? data : p + 8;
    if (size > 4) dv.setUint32(p + 8, offset + data, true);
    switch (t.v.type) {
      case 2:
        buf.set(enc.encode(t.v.text), at);
        break;
      case 3:
        dv.setUint16(at, t.v.value, true);
        break;
      case 4:
        dv.setUint32(at, t.v.value, true);
        break;
      case 5:
        dv.setUint32(at, t.v.num, true);
        dv.setUint32(at + 4, t.v.den, true);
        break;
    }
    if (size > 4) data += size + (size & 1);
  });
  dv.setUint32(2 + sorted.length * 12, 0, true);
  return buf;
}

export function buildExifSegment(x: SampleExif): Uint8Array {
  const exifTags: Tag[] = [
    { tag: 0x829a, v: { type: 5, ...rational(x.exposure) } },
    { tag: 0x829d, v: { type: 5, ...rational(x.fNumber) } },
    { tag: 0x8827, v: { type: 3, value: x.iso } },
    { tag: 0x9003, v: { type: 2, text: x.date } },
    { tag: 0x920a, v: { type: 5, ...rational(x.focal) } },
    { tag: 0xa434, v: { type: 2, text: x.lens } },
  ];
  if (x.focal35) exifTags.push({ tag: 0xa405, v: { type: 3, value: x.focal35 } });
  const ifd0Tags: Tag[] = [
    { tag: 0x010f, v: { type: 2, text: x.make } },
    { tag: 0x0110, v: { type: 2, text: x.model } },
    { tag: 0x0112, v: { type: 3, value: 1 } },
    { tag: 0x0131, v: { type: 2, text: x.software ?? 'KLOUD Studio sample generator' } },
    { tag: 0x0132, v: { type: 2, text: x.date } },
    { tag: 0x8769, v: { type: 4, value: 0 } },
  ];
  if (x.artist) ifd0Tags.push({ tag: 0x013b, v: { type: 2, text: x.artist } });
  // IFD0 size does not depend on the pointer's value: write once to measure, then for real.
  const ifd0Size = writeIfd(ifd0Tags, 8).length;
  const exifOffset = 8 + ifd0Size;
  (ifd0Tags.find((t) => t.tag === 0x8769)!.v as { type: 4; value: number }).value = exifOffset;
  const ifd0 = writeIfd(ifd0Tags, 8);
  const exif = writeIfd(exifTags, exifOffset);
  const tiff = new Uint8Array(8 + ifd0.length + exif.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  tiff.set(ifd0, 8);
  tiff.set(exif, exifOffset);
  const header = enc.encode('Exif\0\0');
  const len = 2 + header.length + tiff.length;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(header, 4);
  seg.set(tiff, 4 + header.length);
  return seg;
}

/** Insert an APP1 EXIF segment into a JPEG (after SOI and a JFIF APP0 when present). */
export function insertExif(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(segment, at);
  out.set(jpeg.subarray(at), at + segment.length);
  return out;
}
