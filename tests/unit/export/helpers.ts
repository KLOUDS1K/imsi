import { unzlibSync } from 'fflate';
import { createEmptyMeta, createDefaultExportSettings } from '@/editor/defaults';
import type { ExportSettings, PhotoMeta, RenderedImage } from '@/editor/types';

/** Deterministic gradient test image (RGBA). */
export function synthImage(width: number, height: number, bitDepth: 8 | 16, alpha = true): RenderedImage {
  const max = bitDepth === 16 ? 65535 : 255;
  const data = bitDepth === 16 ? new Uint16Array(width * height * 4) : new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / Math.max(1, width - 1)) * max);
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * max);
      data[i + 2] = Math.round((((x * 7 + y * 13) % 64) / 63) * max);
      data[i + 3] = alpha ? max : max;
    }
  return { width, height, data, bitDepth, colorSpace: 'srgb' };
}

export function fullMeta(): PhotoMeta {
  return {
    ...createEmptyMeta('DSC01234.ARW'),
    width: 6000,
    height: 4000,
    make: 'SONY',
    model: 'ILCE-7M4',
    camera: 'Sony α7 IV',
    lens: 'FE 35mm F1.4 GM',
    lensMake: 'Sony',
    focalLength: 35,
    focalLength35: 35,
    aperture: 1.4,
    shutter: 1 / 250,
    iso: 400,
    exposureCompensation: -0.7,
    flash: false,
    dateTaken: '2026-05-01T18:42:07+09:00',
    gps: { lat: 37.5665, lon: 126.978, alt: 38 },
  };
}

export function settings(patch: Partial<ExportSettings> = {}): ExportSettings {
  return { ...createDefaultExportSettings(), ...patch };
}

/** Minimal PNG decoder for tests: chunks, CRC check, inflate, unfilter. */
export function decodePng(bytes: Uint8Array) {
  const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  while (p < bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    const crc = dv.getUint32(p + 8 + len);
    chunks.push({ type, data, crcOk: crc === crc32(bytes.subarray(p + 4, p + 8 + len)) });
    p += 12 + len;
  }
  const ihdr = chunks[0].data;
  const idv = new DataView(ihdr.buffer, ihdr.byteOffset);
  const width = idv.getUint32(0);
  const height = idv.getUint32(4);
  const depth = ihdr[8];
  const channels = ihdr[9] === 6 ? 4 : 3;
  const idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = unzlibSync(idat);
  const bpp = channels * (depth / 8);
  const rowBytes = width * bpp;
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)];
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[y * (rowBytes + 1) + 1 + i];
      const a = i >= bpp ? out[y * rowBytes + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * rowBytes + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * rowBytes + i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * rowBytes + i] = (x + pred) & 0xff;
    }
  }
  return { chunks, width, height, depth, channels, pixels: out };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) {
    c ^= d[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A tiny structurally valid baseline JPEG header stream (1×1, fake entropy data). */
export function tinyJpeg(extraSegments: Uint8Array[] = []): Uint8Array {
  const seg = (m: number, body: number[]) => [0xff, m, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  const jfif = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 72, 0, 72, 0, 0]);
  const dqt = seg(0xdb, [0, ...new Array(64).fill(1)]);
  const sof = seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  const dht = seg(0xc4, [0, 1, ...new Array(15).fill(0), 0]);
  const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
  const parts = [
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array(jfif),
    ...extraSegments,
    new Uint8Array(dqt),
    new Uint8Array(sof),
    new Uint8Array(dht),
    new Uint8Array(sos),
    new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56]),
    new Uint8Array([0xff, 0xd9]),
  ];
  return concat(parts);
}
