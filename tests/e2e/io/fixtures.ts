/**
 * Synthetic test files for the io browser checks, built byte by byte so the
 * tests need no binary fixtures: a minimal TIFF writer (used for a 16-bit RGB
 * TIFF and a Bayer CFA DNG), a 16-bit PNG encoder and an EXIF APP1 injector
 * for canvas-encoded JPEGs.
 */
import { zlibSync } from 'fflate';

/* ------------------------------------------------------------------ */
/* Minimal little-endian TIFF writer                                   */
/* ------------------------------------------------------------------ */

export const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 } as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

export interface TiffEntry {
  tag: number;
  type: number;
  /** numbers (RATIONAL/SRATIONAL take [num, den] pairs flattened) or a string for ASCII */
  values: number[] | string;
}

/**
 * Writes a single-IFD LE TIFF: header, IFD, out-of-line values, then the image
 * data. Tag 273 (StripOffsets) is patched to point at `data`.
 */
export function writeTiff(entries: TiffEntry[], data: Uint8Array): Uint8Array {
  const list = entries.slice().sort((a, b) => a.tag - b.tag);
  const norm = list.map((e) => {
    if (typeof e.values === 'string') {
      const bytes = new TextEncoder().encode(e.values + '\0');
      return { ...e, count: bytes.length, bytes };
    }
    const size = TYPE_SIZE[e.type];
    const count = e.type === T.RATIONAL || e.type === T.SRATIONAL ? e.values.length / 2 : e.values.length;
    const bytes = new Uint8Array(count * size);
    const dv = new DataView(bytes.buffer);
    e.values.forEach((v, i) => {
      if (e.type === T.BYTE) dv.setUint8(i, v);
      else if (e.type === T.SHORT) dv.setUint16(i * 2, v, true);
      else if (e.type === T.LONG) dv.setUint32(i * 4, v, true);
      else if (e.type === T.RATIONAL) dv.setUint32(i * 4, v, true);
      else if (e.type === T.SRATIONAL) dv.setInt32(i * 4, v, true);
    });
    return { ...e, count, bytes };
  });
  const ifdSize = 2 + norm.length * 12 + 4;
  let extra = 8 + ifdSize;
  const offsets = norm.map((e) => {
    if (e.bytes.length <= 4) return -1;
    const o = extra;
    extra += e.bytes.length + (e.bytes.length & 1);
    return o;
  });
  const dataOffset = extra;
  const out = new Uint8Array(dataOffset + data.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, norm.length, true);
  norm.forEach((e, i) => {
    const p = 10 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (e.tag === 273) {
      dv.setUint32(p + 8, dataOffset, true);
    } else if (offsets[i] < 0) {
      out.set(e.bytes, p + 8);
    } else {
      dv.setUint32(p + 8, offsets[i], true);
      out.set(e.bytes, offsets[i]);
    }
  });
  dv.setUint32(10 + norm.length * 12, 0, true);
  out.set(data, dataOffset);
  return out;
}

const rational = (v: number, den = 10000): number[] => [Math.round(v * den), den];

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

/** Four flat quadrant colours (linear 0..1) + a white square marker in the top-left quadrant. */
export const QUADS: [number, number, number][] = [
  [0.6, 0.15, 0.1], // top-left: red
  [0.1, 0.5, 0.15], // top-right: green
  [0.1, 0.2, 0.6], // bottom-left: blue
  [0.4, 0.4, 0.4], // bottom-right: grey
];

export function sceneColor(x: number, y: number, w: number, h: number): [number, number, number] {
  const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1);
  return QUADS[q];
}

/* ------------------------------------------------------------------ */
/* DNG                                                                 */
/* ------------------------------------------------------------------ */

export interface DngOptions {
  width: number;
  height: number;
  orientation?: number;
  black?: number;
  white?: number;
  /** Camera neutral (AsShotNeutral), G = 1. */
  neutral?: [number, number, number];
}

/**
 * Uncompressed 16-bit RGGB Bayer DNG whose camera space IS linear sRGB
 * (ColorMatrix1 = XYZ(D65) → linear sRGB, illuminant D65), so a correct decode
 * reproduces `sceneColor` exactly in linear sRGB. The mosaic is recorded
 * through the AsShotNeutral gains (camera sees scene × neutral).
 */
export function buildSyntheticDng(o: DngOptions): Uint8Array {
  const { width: w, height: h } = o;
  const black = o.black ?? 512;
  const white = o.white ?? 16383;
  const neutral = o.neutral ?? [0.5, 1, 0.7];
  const px = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = sceneColor(x, y, w, h);
      // RGGB: (0,0)=R (0,1)=G (1,0)=G (1,1)=B
      const ch = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : (x & 1) === 0 ? 1 : 2;
      const v = c[ch] * neutral[ch];
      px[y * w + x] = Math.round(black + Math.min(1, v) * (white - black));
    }
  }
  // XYZ(D65) → linear sRGB (IEC 61966-2-1)
  const xyzToSrgb = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
  const entries: TiffEntry[] = [
    { tag: 254, type: T.LONG, values: [0] },
    { tag: 256, type: T.LONG, values: [w] },
    { tag: 257, type: T.LONG, values: [h] },
    { tag: 258, type: T.SHORT, values: [16] },
    { tag: 259, type: T.SHORT, values: [1] },
    { tag: 262, type: T.SHORT, values: [32803] },
    { tag: 271, type: T.ASCII, values: 'KLOUD' },
    { tag: 272, type: T.ASCII, values: 'Synthetic CFA' },
    { tag: 273, type: T.LONG, values: [0] },
    { tag: 274, type: T.SHORT, values: [o.orientation ?? 1] },
    { tag: 277, type: T.SHORT, values: [1] },
    { tag: 278, type: T.LONG, values: [h] },
    { tag: 279, type: T.LONG, values: [w * h * 2] },
    { tag: 284, type: T.SHORT, values: [1] },
    { tag: 305, type: T.ASCII, values: 'kloud-io-test' },
    { tag: 33421, type: T.SHORT, values: [2, 2] },
    { tag: 33422, type: T.BYTE, values: [0, 1, 1, 2] },
    { tag: 50706, type: T.BYTE, values: [1, 4, 0, 0] },
    { tag: 50707, type: T.BYTE, values: [1, 1, 0, 0] },
    { tag: 50708, type: T.ASCII, values: 'KLOUD Synthetic CFA' },
    { tag: 50713, type: T.SHORT, values: [1, 1] },
    { tag: 50714, type: T.LONG, values: [black] },
    { tag: 50717, type: T.LONG, values: [white] },
    { tag: 50721, type: T.SRATIONAL, values: xyzToSrgb.flatMap((v) => rational(v)) },
    { tag: 50728, type: T.RATIONAL, values: neutral.flatMap((v) => rational(v)) },
    { tag: 50778, type: T.SHORT, values: [21] },
  ];
  return writeTiff(entries, new Uint8Array(px.buffer));
}

/* ------------------------------------------------------------------ */
/* 16-bit TIFF                                                         */
/* ------------------------------------------------------------------ */

/** Uncompressed 16-bit RGB TIFF of the quadrant scene (sRGB-encoded values). */
export function build16BitTiff(w: number, h: number, orientation = 1): Uint8Array {
  const px = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = sceneColor(x, y, w, h);
      const i = (y * w + x) * 3;
      px[i] = Math.round(c[0] * 65535);
      px[i + 1] = Math.round(c[1] * 65535);
      px[i + 2] = Math.round(c[2] * 65535);
    }
  }
  const entries: TiffEntry[] = [
    { tag: 256, type: T.LONG, values: [w] },
    { tag: 257, type: T.LONG, values: [h] },
    { tag: 258, type: T.SHORT, values: [16, 16, 16] },
    { tag: 259, type: T.SHORT, values: [1] },
    { tag: 262, type: T.SHORT, values: [2] },
    { tag: 273, type: T.LONG, values: [0] },
    { tag: 274, type: T.SHORT, values: [orientation] },
    { tag: 277, type: T.SHORT, values: [3] },
    { tag: 278, type: T.LONG, values: [h] },
    { tag: 279, type: T.LONG, values: [w * h * 6] },
    { tag: 284, type: T.SHORT, values: [1] },
  ];
  return writeTiff(entries, new Uint8Array(px.buffer));
}

/* ------------------------------------------------------------------ */
/* 16-bit PNG                                                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 16-bit RGBA (colorType 6) or RGB (2) PNG with Paeth/Sub/Up filters cycling
 * per row so every unfilter path is exercised.
 */
export function encodePng16(w: number, h: number, rgba: Uint16Array, alpha: boolean): Uint8Array {
  const ch = alpha ? 4 : 3;
  const bpp = ch * 2;
  const stride = w * bpp;
  const raw = new Uint8Array(h * (stride + 1));
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        const v = rgba[(y * w + x) * 4 + c];
        cur[x * bpp + c * 2] = v >> 8;
        cur[x * bpp + c * 2 + 1] = v & 255;
      }
    }
    const filter = y % 5; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
    const o = y * (stride + 1);
    raw[o] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[o + 1 + i] = (cur[i] - pred) & 255;
    }
    prev.set(cur);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 16;
  ihdr[9] = alpha ? 6 : 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* EXIF APP1 injection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Minimal EXIF APP1 segment: IFD0 with Make, Model, Orientation and an EXIF
 * sub-IFD with ExposureTime, FNumber, ISO, DateTimeOriginal, FocalLength and
 * LensModel.
 */
export function buildExifApp1(orientation: number): Uint8Array {
  const tiff = writeTiffIfdOnly(orientation);
  const seg = new Uint8Array(4 + 6 + tiff.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  const len = 2 + 6 + tiff.length;
  seg[2] = len >> 8;
  seg[3] = len & 255;
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(tiff, 10);
  return seg;
}

function writeTiffIfdOnly(orientation: number): Uint8Array {
  // Layout: header(8) | IFD0 (4 entries) | EXIF IFD (6 entries) | values
  const buf = new Uint8Array(512);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49;
  buf[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  let valuePtr = 300;
  const putAscii = (s: string): number => {
    const o = valuePtr;
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
    buf[o + s.length] = 0;
    valuePtr += s.length + 2;
    return o;
  };
  const writeIfd = (at: number, entries: [number, number, number, number][]): number => {
    dv.setUint16(at, entries.length, true);
    entries.forEach(([tag, type, count, value], i) => {
      const p = at + 2 + i * 12;
      dv.setUint16(p, tag, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      if (type === T.SHORT && count === 1) dv.setUint16(p + 8, value, true);
      else dv.setUint32(p + 8, value, true);
    });
    dv.setUint32(at + 2 + entries.length * 12, 0, true);
    return at + 2 + entries.length * 12 + 4;
  };
  const make = putAscii('SONY');
  const model = putAscii('ILCE-7M4');
  const lens = putAscii('FE 24-70mm F2.8 GM II');
  const date = putAscii('2025:05:17 18:42:07');
  const rat = (num: number, den: number): number => {
    const o = valuePtr;
    dv.setUint32(o, num, true);
    dv.setUint32(o + 4, den, true);
    valuePtr += 8;
    return o;
  };
  const exposure = rat(1, 250);
  const fnum = rat(28, 10);
  const focal = rat(35, 1);
  const exifIfdAt = 8 + 2 + 4 * 12 + 4;
  writeIfd(8, [
    [271, T.ASCII, 5, make],
    [272, T.ASCII, 9, model],
    [274, T.SHORT, 1, orientation],
    [34665, T.LONG, 1, exifIfdAt],
  ]);
  writeIfd(exifIfdAt, [
    [33434, T.RATIONAL, 1, exposure],
    [33437, T.RATIONAL, 1, fnum],
    [34855, T.SHORT, 1, 400],
    [36867, T.ASCII, 20, date],
    [37386, T.RATIONAL, 1, focal],
    [42036, T.ASCII, 22, lens],
  ]);
  return buf.subarray(0, valuePtr);
}

/** Insert an APP1 right after SOI (dropping any existing APP0/APP1 from the canvas encoder). */
export function injectExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  let p = 2;
  while (p + 4 < jpeg.length && jpeg[p] === 0xff && (jpeg[p + 1] === 0xe0 || jpeg[p + 1] === 0xe1)) {
    p += 2 + ((jpeg[p + 2] << 8) | jpeg[p + 3]);
  }
  const out = new Uint8Array(2 + app1.length + (jpeg.length - p));
  out.set([0xff, 0xd8], 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(p), 2 + app1.length);
  return out;
}
