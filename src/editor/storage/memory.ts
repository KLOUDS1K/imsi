/**
 * Map-based KloudDB used when IndexedDB is unavailable (private browsing,
 * sandboxed iframes, blocked storage) and in tests. Values are cloned on the
 * way in and out, like IndexedDB does, so callers can never mutate the stored
 * copy by accident.
 */
import type { StoreName } from '@/editor/contracts';
import { STORE_NAMES, type DBOp, type KloudDBExt } from './schema';
import { storageEstimate } from './estimate';

/**
 * Structured-clone a value the way IndexedDB would. Blobs are immutable, so a
 * top-level Blob/File is returned as-is (this also preserves `File` identity,
 * which Node's structuredClone would downgrade to a plain Blob).
 */
function cloneValue<T>(value: T): T {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

/** Rough byte size for estimate(): Blob sizes + typed arrays + a JSON-ish guess for the rest. */
function approxBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (depth > 8 || typeof value !== 'object') return 16;
  let n = 16;
  if (Array.isArray(value)) {
    for (const v of value) n += approxBytes(v, depth + 1);
    return n;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += k.length * 2 + approxBytes(v, depth + 1);
  return n;
}

export class MemoryKloudDB implements KloudDBExt {
  readonly backend = 'memory' as const;
  private readonly stores = new Map<StoreName, Map<string, unknown>>();

  constructor() {
    for (const s of STORE_NAMES) this.stores.set(s, new Map());
  }

  private store(name: StoreName): Map<string, unknown> {
    const s = this.stores.get(name);
    if (!s) throw new DOMException(`No object store named "${name}"`, 'NotFoundError');
    return s;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const s = this.store(store);
    return s.has(key) ? cloneValue(s.get(key) as T) : undefined;
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    this.store(store).set(String(key), cloneValue(value));
  }

  async delete(store: StoreName, key: string): Promise<void> {
    this.store(store).delete(key);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    // IndexedDB returns values in key order; mirror that so both backends behave alike.
    const s = this.store(store);
    return [...s.keys()].sort(compareKeys).map((k) => cloneValue(s.get(k) as T));
  }

  async keys(store: StoreName): Promise<string[]> {
    return [...this.store(store).keys()].sort(compareKeys);
  }

  async clear(store: StoreName): Promise<void> {
    this.store(store).clear();
  }

  async getMany<T>(store: StoreName, keys: readonly string[]): Promise<(T | undefined)[]> {
    const s = this.store(store);
    return keys.map((k) => (s.has(k) ? cloneValue(s.get(k) as T) : undefined));
  }

  async batch(ops: readonly DBOp[]): Promise<void> {
    // Validate and clone everything first so a bad value leaves the stores untouched (all-or-nothing).
    const prepared = ops.map((op) => ({ op, map: this.store(op.store), value: op.type === 'put' ? cloneValue(op.value) : undefined }));
    for (const { op, map, value } of prepared) {
      if (op.type === 'put') map.set(String(op.key), value);
      else map.delete(op.key);
    }
  }

  async estimate(): Promise<{ usage: number; quota: number }> {
    let usage = 0;
    for (const s of this.stores.values()) for (const v of s.values()) usage += approxBytes(v);
    // The quota reported by the browser still bounds what we could persist if storage came back.
    const { quota } = await storageEstimate();
    return { usage, quota };
  }

  close(): void {
    /* nothing to release */
  }
}

/** IndexedDB orders string keys by code unit, which is what `<` does on JS strings. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
