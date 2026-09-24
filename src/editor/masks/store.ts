/**
 * AI mask bitmap store (Map + listeners) with optional write-through
 * persistence, plus a compact binary codec for MaskBitmap.
 */
import { deflateSync, inflateSync } from 'fflate';
import type { AiMaskStore } from '@/editor/contracts';
import type { MaskBitmap } from '@/editor/types';

/** Optional async backing (e.g. the 'maskBitmaps' IndexedDB store). */
export interface AiMaskBacking {
  get(key: string): Promise<MaskBitmap | undefined>;
  put(key: string, bmp: MaskBitmap): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AiMaskStoreExt extends AiMaskStore {
  has(key: string): boolean;
  keys(): string[];
  /** Load `key` from the backing store into memory (resolves true when found). */
  load(key: string): Promise<boolean>;
  clear(): void;
}

export function createAiMaskStore(backing?: AiMaskBacking): AiMaskStoreExt {
  const map = new Map<string, MaskBitmap>();
  const listeners = new Set<(key: string) => void>();
  const emit = (key: string) => {
    for (const l of [...listeners]) {
      try {
        l(key);
      } catch (e) {
        console.error('[masks] AiMaskStore listener failed', e);
      }
    }
  };
  const swallow = (p: Promise<unknown>) => p.catch((e: unknown) => console.warn('[masks] mask bitmap persistence failed', e));
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    set(key, bmp) {
      if (map.get(key) === bmp) return;
      map.set(key, bmp);
      if (backing) swallow(backing.put(key, bmp));
      emit(key);
    },
    delete(key) {
      if (!map.delete(key)) return;
      if (backing) swallow(backing.delete(key));
      emit(key);
    },
    clear() {
      const keys = [...map.keys()];
      map.clear();
      for (const k of keys) emit(k);
    },
    async load(key) {
      if (map.has(key)) return true;
      if (!backing) return false;
      try {
        const bmp = await backing.get(key);
        if (!bmp || map.has(key)) return map.has(key);
        map.set(key, bmp);
        emit(key);
        return true;
      } catch (e) {
        console.warn('[masks] mask bitmap load failed', e);
        return false;
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/* ---------------- binary codec ---------------- */

const MAGIC = 0x314d424b; // 'KBM1' little-endian

/**
 * Layout (little-endian): u32 magic, u32 width, u32 height, u16 keyLength,
 * key (UTF-8), then the coverage deflated with fflate (level 6). Masks are
 * mostly flat regions, so they typically compress 20–100×.
 */
export function serializeMaskBitmap(bmp: MaskBitmap): Uint8Array {
  const key = new TextEncoder().encode(bmp.key);
  if (key.length > 0xffff) throw new Error('mask key too long');
  const body = deflateSync(bmp.data.subarray(0, bmp.width * bmp.height), { level: 6 });
  const out = new Uint8Array(14 + key.length + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, bmp.width, true);
  dv.setUint32(8, bmp.height, true);
  dv.setUint16(12, key.length, true);
  out.set(key, 14);
  out.set(body, 14 + key.length);
  return out;
}

export function deserializeMaskBitmap(bytes: Uint8Array | ArrayBuffer): MaskBitmap {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 14) throw new Error('mask bitmap: truncated header');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('mask bitmap: bad magic');
  const width = dv.getUint32(4, true);
  const height = dv.getUint32(8, true);
  const kl = dv.getUint16(12, true);
  if (14 + kl > b.length) throw new Error('mask bitmap: truncated key');
  const key = new TextDecoder().decode(b.subarray(14, 14 + kl));
  const data = inflateSync(b.subarray(14 + kl), { out: new Uint8Array(width * height) });
  if (data.length !== width * height) throw new Error('mask bitmap: size mismatch');
  return { width, height, data, key };
}
