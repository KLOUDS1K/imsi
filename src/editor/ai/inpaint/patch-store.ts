/**
 * PatchStore: in-memory PatchProvider for removal-patch pixels, plus a compact
 * binary format for IndexedDB persistence (storage 'patches').
 *
 * Format "KPT1" (little-endian):
 *   0  u8[4]  magic 'K','P','T','1'
 *   4  u32    width
 *   8  u32    height
 *   12 u8     transfer (0 = srgb, 1 = linear)
 *   13 u8     sample type (0 = u8, 1 = u16, 2 = f32)
 *   14 u8     flags (bit 0: RGB of alpha-0 pixels was zeroed)
 *   15 u8     reserved
 *   16 …      zlib stream of the filtered samples
 * Filter: integer samples are stored as the difference to the same channel of
 * the previous pixel in the row (PNG "Sub"), which makes smooth fills compress
 * several times better. Float samples are stored raw.
 *
 * Because the engine composites patches premultiplied, the colour of fully
 * transparent pixels never shows; serializePatch zeroes it by default
 * (`dropHidden`) so the empty corners of the bbox compress to almost nothing.
 */
import { unzlibSync, zlibSync } from 'fflate';
import type { PatchProvider } from '@/editor/contracts';
import type { PixelBuffer } from '@/editor/types';

export type PatchStore = PatchProvider & {
  set(key: string, px: PixelBuffer): void;
  delete(key: string): void;
  keys(): string[];
  has(key: string): boolean;
  clear(): void;
  /** Called with the key whenever a patch is set or deleted (e.g. to schedule a re-render / persist). */
  onChange(cb: (key: string) => void): () => void;
};

export function createPatchStore(): PatchStore {
  const map = new Map<string, PixelBuffer>();
  const listeners = new Set<(key: string) => void>();
  const emit = (key: string) => {
    for (const l of [...listeners]) l(key);
  };
  return {
    getPatch: (key) => map.get(key) ?? null,
    set(key, px) {
      map.set(key, px);
      emit(key);
    },
    delete(key) {
      if (map.delete(key)) emit(key);
    },
    keys: () => [...map.keys()],
    has: (key) => map.has(key),
    clear() {
      const keys = [...map.keys()];
      map.clear();
      keys.forEach(emit);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const MAGIC = [0x4b, 0x50, 0x54, 0x31];

export function serializePatch(px: PixelBuffer, opts: { dropHidden?: boolean; level?: number } = {}): Uint8Array {
  const { width, height, data } = px;
  const n = width * height * 4;
  if (data.length < n) throw new Error('serializePatch: pixel data is shorter than width×height×4');
  const type = data instanceof Float32Array ? 2 : data instanceof Uint16Array ? 1 : 0;
  const dropHidden = opts.dropHidden !== false;
  let payload: Uint8Array;
  if (type === 2) {
    const f = new Float32Array(data.subarray(0, n) as Float32Array);
    if (dropHidden) zeroHidden(f);
    payload = new Uint8Array(f.buffer);
  } else if (type === 1) {
    const src = data as Uint16Array;
    const f = new Uint16Array(n);
    subFilter(src, f, width, height, dropHidden, 0xffff);
    payload = new Uint8Array(f.buffer);
  } else {
    const f = new Uint8Array(n);
    subFilter(data as Uint8Array | Uint8ClampedArray, f, width, height, dropHidden, 0xff);
    payload = f;
  }
  const z = zlibSync(payload, { level: (opts.level ?? 6) as 6 });
  const out = new Uint8Array(16 + z.length);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, width, true);
  dv.setUint32(8, height, true);
  out[12] = px.transfer === 'linear' ? 1 : 0;
  out[13] = type;
  out[14] = dropHidden ? 1 : 0;
  out.set(z, 16);
  return out;
}

export function deserializePatch(bytes: Uint8Array | ArrayBuffer): PixelBuffer {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16 || MAGIC.some((m, i) => b[i] !== m)) throw new Error('deserializePatch: not a KPT1 patch');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const transfer = b[12] === 1 ? 'linear' : 'srgb';
  const type = b[13];
  const n = width * height * 4;
  const raw = unzlibSync(b.subarray(16));
  if (type === 2) {
    if (raw.byteLength !== n * 4) throw new Error('deserializePatch: corrupt float payload');
    const data = new Float32Array(n);
    new Uint8Array(data.buffer).set(raw);
    return { width, height, data, transfer };
  }
  if (type === 1) {
    if (raw.byteLength !== n * 2) throw new Error('deserializePatch: corrupt 16-bit payload');
    const f = new Uint16Array(n);
    new Uint8Array(f.buffer).set(raw);
    const data = new Uint16Array(n);
    unSubFilter(f, data, width, height, 0xffff);
    return { width, height, data, transfer };
  }
  if (raw.length !== n) throw new Error('deserializePatch: corrupt 8-bit payload');
  const data = new Uint8ClampedArray(n);
  unSubFilter(raw, data, width, height, 0xff);
  return { width, height, data, transfer };
}

type IntArray = Uint8Array | Uint8ClampedArray | Uint16Array;

function subFilter(src: IntArray, dst: IntArray, w: number, h: number, dropHidden: boolean, mask: number): void {
  for (let y = 0; y < h; y++) {
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = src[i + 3];
      const hidden = dropHidden && a === 0;
      const r = hidden ? 0 : src[i];
      const g = hidden ? 0 : src[i + 1];
      const b = hidden ? 0 : src[i + 2];
      dst[i] = (r - pr) & mask;
      dst[i + 1] = (g - pg) & mask;
      dst[i + 2] = (b - pb) & mask;
      dst[i + 3] = (a - pa) & mask;
      pr = r;
      pg = g;
      pb = b;
      pa = a;
    }
  }
}

function unSubFilter(src: IntArray, dst: IntArray, w: number, h: number, mask: number): void {
  for (let y = 0; y < h; y++) {
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      pr = (pr + src[i]) & mask;
      pg = (pg + src[i + 1]) & mask;
      pb = (pb + src[i + 2]) & mask;
      pa = (pa + src[i + 3]) & mask;
      dst[i] = pr;
      dst[i + 1] = pg;
      dst[i + 2] = pb;
      dst[i + 3] = pa;
    }
  }
}

function zeroHidden(f: Float32Array): void {
  for (let i = 0; i < f.length; i += 4) {
    if (f[i + 3] <= 0) {
      f[i] = 0;
      f[i + 1] = 0;
      f[i + 2] = 0;
    }
  }
}
